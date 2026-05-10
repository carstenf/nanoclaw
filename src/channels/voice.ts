/**
 * Voice channel adapter (v2) — Pattern-B inversion to voice-mcp.
 *
 * Architecture:
 *   voice-mcp (MCP server, runs on the voice-stack host) ←→
 *     this adapter (MCP client, long-poll)              ←→
 *       NanoClaw router → agent_group session → container → answer
 *
 * Inbound: long-poll voice_wait_for_question, emit each pending question
 *   as an InboundEvent with channelType='voice', platformId='default',
 *   threadId=call_id. Router resolves to a per-thread session — one
 *   session per call.
 *
 * Outbound: deliver() posts the container's reply via voice_post_answer
 *   (TTS-readable text) and fans out the same content to the wired
 *   agent_group's primary Discord destination via the live delivery
 *   adapter. Discord-fanout is fire-and-forget — voice answer must not
 *   block on Discord.
 *
 * Raw fetch instead of @modelcontextprotocol/sdk: voice-mcp's
 * StreamableHTTP endpoint accepts JSON-RPC tool calls without a
 * stateful initialize handshake, so a 30-line raw client keeps the
 * trunk MCP-SDK-free on the host side.
 */
import { getDb } from '../db/connection.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';

export const VOICE_CHANNEL_TYPE = 'voice';
export const VOICE_PLATFORM_ID = 'default';

const POLL_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const FETCH_TIMEOUT_MS = 45_000; // poll timeout + 15s margin

interface PendingQuestion {
  empty: boolean;
  call_id?: string;
  topic?: string;
  request?: string;
}

interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Call a single MCP tool on voice-mcp. Returns the parsed inner result
 * payload (the `{ ok, result | error }` object voice-mcp wraps every
 * response in), or null on transport / parse failure. Caller decides
 * what to do with `ok=false`.
 */
async function callMcpTool(
  url: string,
  bearer: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult | null> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args },
  });
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json,text/event-stream',
      },
      body,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    log.warn('voice_mcp_call_fetch_failed', {
      tool: name,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!res.ok) {
    log.warn('voice_mcp_call_http_error', { tool: name, status: res.status });
    return null;
  }
  const text = await res.text();
  // voice-mcp returns SSE-shaped output even for one-shot calls:
  //   "event: message\ndata: { ... }\n\n"
  let payload: unknown;
  if (text.startsWith('event:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) return null;
    try {
      payload = JSON.parse(dataLine.slice(6));
    } catch {
      return null;
    }
  } else {
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }
  }
  // payload is the JSON-RPC envelope; extract the tool's text content.
  const inner = (payload as Record<string, unknown> | undefined)?.result as
    | Record<string, unknown>
    | undefined;
  const content = inner?.content as Array<Record<string, unknown>> | undefined;
  const firstText = content?.[0]?.text;
  if (typeof firstText !== 'string') return null;
  try {
    return JSON.parse(firstText) as ToolResult;
  } catch {
    return null;
  }
}

/**
 * Pull plain text out of an outbound message. Containers normally write
 * `{ markdown: "..." }` or `{ text: "..." }`. Other shapes (cards,
 * ask_question, files-only) aren't TTS-renderable — we drop them with a
 * warn rather than reading garbage to the caller.
 */
function extractTextFromOutbound(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | null;
  if (typeof content === 'string') return content || null;
  if (!content || typeof content !== 'object') return null;
  const md = content.markdown;
  if (typeof md === 'string' && md.length > 0) return md;
  const text = content.text;
  if (typeof text === 'string' && text.length > 0) return text;
  return null;
}

/**
 * Find the Discord messaging_group wired to the same agent_group(s)
 * that handle voice. Returns the (channel_type, platform_id) tuple to
 * fan out a parallel delivery, or null if no Discord wiring exists.
 *
 * Picked at deliver-time (not adapter-init) so the wiring can be added
 * later without restarting the host.
 */
function pickDiscordFanoutTarget(): { channelType: string; platformId: string } | null {
  const db = getDb();
  // Find every agent_group wired to the voice MG, then pick its first
  // Discord wiring. ORDER BY priority lets an installation prefer a
  // specific Discord wiring if multiple exist.
  const row = db
    .prepare(
      `SELECT mg.channel_type AS channel_type, mg.platform_id AS platform_id
         FROM messaging_groups vmg
         JOIN messaging_group_agents vmga ON vmga.messaging_group_id = vmg.id
         JOIN messaging_group_agents dmga ON dmga.agent_group_id = vmga.agent_group_id
         JOIN messaging_groups mg ON mg.id = dmga.messaging_group_id
        WHERE vmg.channel_type = ?
          AND vmg.platform_id = ?
          AND mg.channel_type = 'discord'
        ORDER BY dmga.priority DESC
        LIMIT 1`,
    )
    .get(VOICE_CHANNEL_TYPE, VOICE_PLATFORM_ID) as
    | { channel_type: string; platform_id: string }
    | undefined;
  if (!row) return null;
  return { channelType: row.channel_type, platformId: row.platform_id };
}

class VoiceAdapter implements ChannelAdapter {
  name = 'voice';
  channelType = VOICE_CHANNEL_TYPE;
  supportsThreads = true;

  private url: string;
  private bearer: string;
  private hostConfig: ChannelSetup | null = null;
  private running = false;
  private connected = false;
  private abortController: AbortController | null = null;
  private reconnectAttempts = 0;

  constructor(url: string, bearer: string) {
    this.url = url;
    this.bearer = bearer;
  }

  async setup(hostConfig: ChannelSetup): Promise<void> {
    this.hostConfig = hostConfig;
    this.running = true;
    void this.runLoop();
  }

  async teardown(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async deliver(
    platformId: string,
    threadId: string | null,
    message: OutboundMessage,
  ): Promise<string | undefined> {
    if (!threadId) {
      log.warn('voice_deliver_missing_call_id', { platformId, kind: message.kind });
      return undefined;
    }
    const callId = threadId;
    const text = extractTextFromOutbound(message);
    if (!text) {
      log.warn('voice_deliver_no_renderable_text', { callId, kind: message.kind });
      return undefined;
    }
    const res = await callMcpTool(this.url, this.bearer, 'voice_post_answer', {
      call_id: callId,
      voice_short: text,
      discord_long: null,
    });
    log.info('voice_post_answer_sent', {
      callId,
      ok: res?.ok ?? false,
      length: text.length,
    });
    void this.fanoutToDiscord(callId, text).catch((err) =>
      log.warn('voice_discord_fanout_failed', {
        callId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return undefined;
  }

  private async fanoutToDiscord(callId: string, text: string): Promise<void> {
    const target = pickDiscordFanoutTarget();
    if (!target) {
      log.debug('voice_discord_fanout_no_target', { callId });
      return;
    }
    // Lazy import to avoid circular: delivery imports channels for typing.
    const { getDeliveryAdapter } = await import('../delivery.js');
    const da = getDeliveryAdapter();
    if (!da) {
      log.warn('voice_discord_fanout_no_delivery_adapter', { callId });
      return;
    }
    const content = JSON.stringify({ markdown: text });
    await da.deliver(target.channelType, target.platformId, null, 'message', content);
    log.info('voice_discord_fanout_sent', {
      callId,
      channelType: target.channelType,
      platformId: target.platformId,
      length: text.length,
    });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const fetchTimeout = setTimeout(
          () => this.abortController?.abort(),
          FETCH_TIMEOUT_MS,
        );
        let res: ToolResult | null;
        try {
          res = await callMcpTool(
            this.url,
            this.bearer,
            'voice_wait_for_question',
            { timeout_ms: POLL_TIMEOUT_MS },
            this.abortController.signal,
          );
        } finally {
          clearTimeout(fetchTimeout);
        }
        if (!this.running) return;
        if (!res || res.ok !== true) {
          if (this.connected) {
            this.connected = false;
            log.warn('voice_mcp_client_disconnected', {
              error: res?.error ?? 'transport_or_parse_failure',
            });
          }
          await this.backoff();
          continue;
        }
        if (!this.connected) {
          this.connected = true;
          this.reconnectAttempts = 0;
          log.info('voice_mcp_client_connected', { url: this.url });
        }
        const q = res.result as PendingQuestion | undefined;
        if (!q || q.empty) continue;
        if (typeof q.call_id !== 'string' || typeof q.request !== 'string') {
          log.warn('voice_question_invalid_shape', {
            keys: q ? Object.keys(q) : null,
          });
          continue;
        }
        await this.emitInbound(q.call_id, q.request, q.topic ?? null);
      } catch (err) {
        if (!this.running) return;
        log.warn('voice_mcp_client_loop_error', {
          err: err instanceof Error ? err.message : String(err),
        });
        this.connected = false;
        await this.backoff();
      }
    }
  }

  private async emitInbound(
    callId: string,
    request: string,
    topic: string | null,
  ): Promise<void> {
    if (!this.hostConfig) return;
    log.info('voice_request_received', { callId, topic, length: request.length });
    const message: InboundMessage = {
      id: `voice-${callId}-${Date.now()}`,
      kind: 'chat',
      content: {
        text: request,
        sender: topic ?? 'voice-caller',
        senderId: `voice:${callId}`,
      },
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
    };
    try {
      await this.hostConfig.onInbound(VOICE_PLATFORM_ID, callId, message);
    } catch (err) {
      log.error('voice_emit_inbound_failed', {
        callId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async backoff(): Promise<void> {
    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
}

registerChannelAdapter(VOICE_CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile(['VOICE_MCP_URL', 'VOICE_MCP_BEARER']);
    const url = process.env.VOICE_MCP_URL ?? env.VOICE_MCP_URL ?? '';
    const bearer = process.env.VOICE_MCP_BEARER ?? env.VOICE_MCP_BEARER ?? '';
    if (!url || !bearer) {
      log.info('voice_adapter_disabled', {
        reason: 'VOICE_MCP_URL or VOICE_MCP_BEARER not set',
      });
      return null;
    }
    return new VoiceAdapter(url, bearer);
  },
});

// Test-only export for unit tests.
export const __voiceTestables = {
  callMcpTool,
  extractTextFromOutbound,
  pickDiscordFanoutTarget,
  VoiceAdapter,
};
