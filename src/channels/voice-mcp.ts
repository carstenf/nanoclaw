// src/channels/voice-mcp.ts
//
// V2.3 — long-lived WebSocket client to voice-mcp on Hetzner. Architecturally
// modeled after channels/discord.ts: NanoClaw initiates the outbound
// connection, holds it open, receives push events, and replies. No inbound
// port on Lenovo1.
//
// Wire protocol (mirror of voice-mcp/src/nanoclaw-bridge.ts):
//
//   server → client (trigger):
//     { "type": "trigger", "id": "uuid", "tool": "voice_triggers_init",
//       "args": { ... } }
//
//   client → server (response):
//     { "type": "response", "id": "uuid",
//       "result": { ok: true, result: ... } | { ok: false, error: "..." } }
//
//   either side (heartbeat): {"type":"ping"} → {"type":"pong"}
//
// Trigger dispatch routes to existing in-process handlers:
//   voice_triggers_init       → registry.invoke('voice_triggers_init', args)
//   voice_triggers_transcript → registry.invoke('voice_triggers_transcript', args)
//   voice_send_discord_message → registry.invoke('voice_send_discord_message', args)
//   voice_ask_core            → makeVoiceAskCoreHandler (req-shimmed)
//
// Auto-reconnect with exponential backoff, capped — analogous to how the
// Discord client auto-reconnects on socket loss.

import WebSocket from 'ws';

import { logger } from '../logger.js';
import type { ToolRegistry } from '../mcp-tools/index.js';
import {
  type VoiceRespondManager,
  VoiceRespondTimeoutError,
} from '../voice-channel/index.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

export interface VoiceMcpClientOpts {
  url: string;
  bearer: string;
  registry: ToolRegistry;
  voiceRespondManager: VoiceRespondManager;
  tryInjectVoiceRequest: (callId: string, request: string) => boolean;
  warmupContainer: () => void;
  defaultAskCoreTimeoutMs?: number;
}

interface AskCoreArgs {
  call_id: string;
  topic?: string;
  request: string;
  warmup?: boolean;
  timeout_ms?: number;
}

export class VoiceMcpClient {
  name = 'voice-mcp';

  private ws: WebSocket | null = null;
  private opts: VoiceMcpClientOpts;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(opts: VoiceMcpClientOpts) {
    this.opts = opts;
  }

  start(): void {
    this.stopping = false;
    this.connect();
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopping) return;
    const url = this.opts.url;
    logger.info({ event: 'voice_mcp_client_connecting', url });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.opts.bearer}`,
        },
      });
    } catch (err) {
      logger.warn({
        event: 'voice_mcp_client_construct_failed',
        err: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.armHeartbeatTimeout();
      logger.info({ event: 'voice_mcp_client_connected', url });
    });

    ws.on('message', (data: Buffer | string) => {
      this.armHeartbeatTimeout();
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch (err) {
        logger.warn({
          event: 'voice_mcp_client_bad_message',
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });

    ws.on('close', (code, reason) => {
      logger.info({
        event: 'voice_mcp_client_disconnected',
        code,
        reason: reason.toString(),
      });
      this.ws = null;
      if (this.heartbeatTimer) {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.warn({
        event: 'voice_mcp_client_socket_error',
        err: err.message,
      });
      // close handler will reconnect
    });
  }

  private armHeartbeatTimeout(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      logger.warn({ event: 'voice_mcp_client_heartbeat_timeout' });
      try {
        this.ws?.terminate();
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_TIMEOUT_MS);
    this.heartbeatTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; id?: string; tool?: string; args?: unknown };
    switch (m.type) {
      case 'pong':
        return;
      case 'ping':
        this.send({ type: 'pong' });
        return;
      case 'trigger': {
        if (typeof m.id !== 'string' || typeof m.tool !== 'string') {
          logger.warn({
            event: 'voice_mcp_client_malformed_trigger',
            id: m.id,
            tool: m.tool,
          });
          return;
        }
        const result = await this.dispatchTrigger(m.tool, m.args);
        this.send({ type: 'response', id: m.id, result });
        return;
      }
      default:
        logger.warn({
          event: 'voice_mcp_client_unknown_message_type',
          type: m.type,
        });
    }
  }

  private async dispatchTrigger(tool: string, args: unknown): Promise<unknown> {
    try {
      switch (tool) {
        case 'voice_triggers_init':
        case 'voice_triggers_transcript':
        case 'voice_send_discord_message':
          return await this.opts.registry.invoke(tool, args);
        case 'voice_ask_core':
          return await this.handleAskCore(args as AskCoreArgs);
        default:
          return { ok: false, error: 'unknown_tool', tool };
      }
    } catch (err) {
      logger.warn({
        event: 'voice_mcp_client_dispatch_failed',
        tool,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        error: 'internal',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Mirror of channels/voice-ask-core.ts handler logic but as a direct
   * function rather than an HTTP middleware. Reuses VoiceRespondManager +
   * tryInjectVoiceRequest from index.ts so behavior matches the legacy
   * /voice/ask_core HTTP route exactly.
   */
  private async handleAskCore(args: AskCoreArgs): Promise<unknown> {
    const callId = args.call_id;
    const topic = args.topic ?? 'andy';
    const request = args.request ?? '';
    const warmup = args.warmup === true;
    const timeoutMs = args.timeout_ms ?? this.opts.defaultAskCoreTimeoutMs ?? 90_000;

    if (warmup) {
      try {
        this.opts.warmupContainer();
      } catch (err) {
        logger.warn({
          event: 'voice_ask_core_warmup_failed',
          call_id: callId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info({ event: 'voice_ask_core_warmup_ok', call_id: callId });
      return { ok: true, result: { warmup: true } };
    }

    const pendingPromise = this.opts.voiceRespondManager.register(callId, timeoutMs);
    const injected = this.opts.tryInjectVoiceRequest(callId, request);
    if (!injected) {
      pendingPromise.catch(() => undefined);
      this.opts.voiceRespondManager.cancel(callId, 'no_active_container');
      logger.info({
        event: 'voice_ask_core_no_active_container',
        call_id: callId,
        topic,
      });
      return {
        ok: true,
        result: {
          voice_short:
            'Andy ist gerade nicht erreichbar. Bitte ping Andy kurz auf Discord, dann nochmal anrufen.',
          discord_long: null,
          source: 'no_active_container',
        },
      };
    }

    try {
      const t0 = Date.now();
      const payload = await pendingPromise;
      const elapsed = Date.now() - t0;
      logger.info({
        event: 'voice_ask_core_done',
        call_id: callId,
        topic,
        elapsed_ms: elapsed,
        voice_short_len: payload.voice_short.length,
        has_discord_long: !!payload.discord_long,
      });
      return {
        ok: true,
        result: {
          voice_short: payload.voice_short,
          discord_long: payload.discord_long ?? null,
          source: 'andy',
          elapsed_ms: elapsed,
        },
      };
    } catch (err) {
      if (err instanceof VoiceRespondTimeoutError) {
        logger.warn({
          event: 'voice_ask_core_timeout',
          call_id: callId,
          topic,
          timeout_ms: timeoutMs,
        });
        return {
          ok: true,
          result: {
            voice_short:
              'Andy meldet sich gerade nicht — sag dem Anrufer, ich melde mich später nochmal.',
            discord_long: null,
            source: 'timeout',
          },
        };
      }
      logger.warn({
        event: 'voice_ask_core_error',
        call_id: callId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'internal' };
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      logger.warn({
        event: 'voice_mcp_client_send_failed',
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
