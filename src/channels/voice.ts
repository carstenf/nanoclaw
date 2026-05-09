// src/channels/voice.ts
//
// Voice-channel adapter. V2-friendly refactor: voice-stack lives at
// `mcp-voice-channel` (Hetzner) and is the single integration point for
// everything telephony — bridge ↔ FreeSWITCH ↔ OpenAI Realtime ↔ Andy
// outbound-MCP. Trunk only exposes one inbound surface: POST /voice/dispatch.
//
// Wire protocol (mirror of voice-mcp/src/orchestrator/dispatcher.ts):
//
//   POST ${VOICE_DISPATCH_BIND}:${VOICE_DISPATCH_PORT}/voice/dispatch
//   Authorization: Bearer ${VOICE_DISPATCH_BEARER}
//   Body: { tool: string, args: unknown }
//   200  { ok: true,  result: <tool-specific> }
//        { ok: false, error: <string> }
//
// Dispatch routing is plug-in: callers register one handler per tool name
// via setHandler(name, fn). Tools that need agent invocation (voice_ask_core)
// register a handler that spawns the voice-context container; deterministic
// tools (voice_triggers_init, voice_triggers_transcript, etc.) register pure
// in-process handlers. The channel knows nothing about either.
//
// Channel-interface fit: voice is request/response RPC, not a chat stream.
// `sendMessage` is a no-op — voice-mcp delivers responses itself. `ownsJid`
// recognises `voice:<call_id>` synthetic jids that callers can use when they
// want to stamp a chat-jid onto a voice context.

import http from 'node:http';

import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { loadVoiceChannelConfig, VoiceChannelConfig } from '../voice-channel-config.js';

export type VoiceDispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export type VoiceDispatchHandler = (
  args: unknown,
) => Promise<VoiceDispatchResult>;

export class VoiceChannel implements Channel {
  name = 'voice';

  private config: VoiceChannelConfig;
  private server: http.Server | null = null;
  private handlers = new Map<string, VoiceDispatchHandler>();

  constructor(config: VoiceChannelConfig, _opts: ChannelOpts) {
    this.config = config;
  }

  setHandler(tool: string, handler: VoiceDispatchHandler): void {
    this.handlers.set(tool, handler);
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.dispatchPort, this.config.dispatchBind, () => {
        logger.info({
          event: 'voice_dispatch_listening',
          bind: this.config.dispatchBind,
          port: this.config.dispatchPort,
        });
        resolve();
      });
    });
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // Voice does not deliver via this channel — voice-mcp owns the
    // realtime audio path. Operator-deliverable text routes through
    // discord/whatsapp via Andy's voice_ask_core handler instead.
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('voice:');
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/voice/dispatch') {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${this.config.dispatchBearer}`) {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      let envelope: { tool?: unknown; args?: unknown };
      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'bad_json' }));
        return;
      }
      const tool = typeof envelope.tool === 'string' ? envelope.tool : '';
      const handler = this.handlers.get(tool);
      if (!handler) {
        res.writeHead(200).end(
          JSON.stringify({ ok: false, error: 'unknown_tool' }),
        );
        return;
      }
      try {
        const result = await handler(envelope.args);
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(result),
        );
      } catch (err) {
        logger.warn({
          event: 'voice_dispatch_handler_threw',
          tool,
          err: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(200).end(
          JSON.stringify({ ok: false, error: 'internal' }),
        );
      }
    });
    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400).end();
    });
  }
}

let _voiceChannel: VoiceChannel | null = null;

export function getVoiceChannel(): VoiceChannel | null {
  return _voiceChannel;
}

registerChannel('voice', (opts: ChannelOpts) => {
  const config = loadVoiceChannelConfig();
  if (!config) {
    logger.warn(
      'Voice: VOICE_MCP_URL / VOICE_MCP_BEARER / VOICE_DISPATCH_BEARER not set',
    );
    return null;
  }
  _voiceChannel = new VoiceChannel(config, opts);
  return _voiceChannel;
});
