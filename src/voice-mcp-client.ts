// src/voice-mcp-client.ts
//
// Pattern-B: NanoClaw acts as MCP CLIENT to voice-mcp's MCP SERVER —
// architectural mirror of how Andy (container) is MCP client to hindsight.
//
// Single inversion path: voice → Andy. Implemented as a long-poll loop:
//   1. Call voice_wait_for_question(timeout_ms=30000) on voice-mcp.
//   2. On question received: inject voice_request envelope into the main
//      container's IPC dir (queue.sendVoiceRequest). Andy's container
//      processes the turn and emits a voice_response output marker.
//   3. runAgent's onOutput sees the marker, calls VoiceRespondManager.resolve.
//   4. The askMain Promise resolves; we call voice_post_answer back.
//   5. Loop.
//
// Connect retries with exponential backoff. On voice-mcp restart we just
// reconnect — long-poll empty returns are normal.
//
// All other voice → NanoClaw flows (persona render, Discord posting, retry
// scheduling, wake-up) live entirely in voice-mcp. This client is the only
// trunk-side voice surface.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import type { GroupQueue } from './group-queue.js';
import type { RegisteredGroup } from './types.js';
import { runContainerAgent } from './container-runner.js';
import {
  getVoiceRespondManager,
  type VoiceAnswer,
} from './voice-respond-manager.js';

const POLL_TIMEOUT_MS = 30_000;
const ANSWER_TIMEOUT_MS = 90_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface VoiceMcpClientDeps {
  queue: GroupQueue;
  getMainGroupAndJid: () => { folder: string; jid: string } | null;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  assistantName: string;
}

interface PendingQuestion {
  empty: boolean;
  call_id?: string;
  topic?: string;
  request?: string;
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
}

function parseToolResult(raw: ToolResult): unknown {
  const text = raw?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class VoiceMcpClient {
  private deps: VoiceMcpClientDeps;
  private url: string;
  private bearer: string;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private running = false;
  private reconnectAttempts = 0;

  constructor(deps: VoiceMcpClientDeps, url: string, bearer: string) {
    this.deps = deps;
    this.url = url;
    this.bearer = bearer;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    void this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.transport?.close().catch(() => undefined);
    await this.client?.close().catch(() => undefined);
    this.client = null;
    this.transport = null;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.bearer}` },
      },
    });
    const client = new Client(
      { name: 'nanoclaw-voice-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    this.reconnectAttempts = 0;
    logger.info({
      event: 'voice_mcp_client_connected',
      url: this.url,
    });
  }

  private async dropConnection(): Promise<void> {
    await this.transport?.close().catch(() => undefined);
    await this.client?.close().catch(() => undefined);
    this.client = null;
    this.transport = null;
  }

  private async backoff(): Promise<void> {
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    await new Promise((r) => setTimeout(r, delay));
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.ensureConnected();
        const raw = (await this.client!.callTool({
          name: 'voice_wait_for_question',
          arguments: { timeout_ms: POLL_TIMEOUT_MS },
        })) as ToolResult;
        const parsed = parseToolResult(raw) as
          | { ok: true; result: PendingQuestion }
          | { ok: false; error: string }
          | null;
        if (!parsed || parsed.ok !== true) {
          logger.warn({
            event: 'voice_wait_for_question_bad_response',
            err: parsed && parsed.ok === false ? parsed.error : 'no_response',
          });
          continue;
        }
        const result = parsed.result;
        if (result.empty) continue;

        // Question to dispatch.
        if (
          typeof result.call_id !== 'string' ||
          typeof result.request !== 'string'
        ) {
          continue;
        }
        // Run the full handle flow async so the next dequeue starts asap.
        void this.handleQuestion(result.call_id, result.request);
      } catch (err) {
        if (!this.running) return;
        logger.warn({
          event: 'voice_mcp_client_loop_error',
          err: err instanceof Error ? err.message : String(err),
        });
        await this.dropConnection();
        await this.backoff();
      }
    }
  }

  private async handleQuestion(call_id: string, request: string): Promise<void> {
    const start = Date.now();
    let answer: VoiceAnswer | null = null;
    let error: string | null = null;
    try {
      answer = await this.askMain(call_id, request);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    try {
      await this.ensureConnected();
      await this.client!.callTool({
        name: 'voice_post_answer',
        arguments: {
          call_id,
          voice_short:
            answer?.voice_short ??
            'Ich kann das gerade nicht abrufen — Details kommen auf Discord.',
          discord_long: answer?.discord_long ?? null,
        },
      });
      logger.info({
        event: 'voice_post_answer_sent',
        call_id,
        latency_ms: Date.now() - start,
        had_error: error !== null,
      });
    } catch (postErr) {
      logger.warn({
        event: 'voice_post_answer_failed',
        call_id,
        err: postErr instanceof Error ? postErr.message : String(postErr),
      });
      await this.dropConnection();
    }
  }

  private async askMain(call_id: string, request: string): Promise<VoiceAnswer> {
    const main = this.deps.getMainGroupAndJid();
    if (!main) throw new Error('no_main_group');

    // Try IPC-inject first — fast path when main container is alive.
    const injected = this.deps.queue.sendVoiceRequest(
      main.jid,
      call_id,
      request,
    );
    if (injected) {
      const manager = getVoiceRespondManager();
      return manager.register(call_id, ANSWER_TIMEOUT_MS);
    }

    // Cold-spawn fallback. Slow but correct when no main container is up.
    return this.coldSpawn(call_id, request, main);
  }

  private async coldSpawn(
    call_id: string,
    request: string,
    main: { folder: string; jid: string },
  ): Promise<VoiceAnswer> {
    const groups = this.deps.getRegisteredGroups();
    const group = groups[main.jid];
    if (!group) throw new Error('no_main_group');

    let voiceShort = '';
    const wrapped = `<voice_request call_id="${call_id}">\n${request}\n</voice_request>`;
    const out = await runContainerAgent(
      group,
      {
        prompt: wrapped,
        groupFolder: group.folder,
        chatJid: main.jid,
        isMain: true,
        assistantName: this.deps.assistantName,
      },
      () => {},
      async (output) => {
        if (output.status === 'success' && typeof output.result === 'string') {
          voiceShort = output.result
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
        }
      },
    );
    if (out.status === 'error') {
      throw new Error(out.error || 'agent_error');
    }
    return { voice_short: voiceShort, discord_long: null };
  }
}

let _client: VoiceMcpClient | null = null;

export function startVoiceMcpClient(deps: VoiceMcpClientDeps): VoiceMcpClient | null {
  const env = readEnvFile(['VOICE_MCP_URL', 'VOICE_MCP_BEARER']);
  const url = process.env.VOICE_MCP_URL ?? env.VOICE_MCP_URL ?? '';
  const bearer = process.env.VOICE_MCP_BEARER ?? env.VOICE_MCP_BEARER ?? '';
  if (!url || !bearer) {
    logger.info({
      event: 'voice_mcp_client_disabled',
      reason: 'VOICE_MCP_URL or VOICE_MCP_BEARER not set',
    });
    return null;
  }
  const client = new VoiceMcpClient(deps, url, bearer);
  _client = client;
  void client.start();
  return client;
}

export function getVoiceMcpClient(): VoiceMcpClient | null {
  return _client;
}
