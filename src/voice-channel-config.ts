// src/voice-channel-config.ts
//
// Voice-channel configuration. Reads env vars from .env (analog memory.ts
// pattern from the hindsight skill) — process.env is only consulted when
// readEnvFile turns up nothing, so secrets don't leak to child processes.
//
// Required:
//   VOICE_MCP_URL                   voice-mcp /mcp endpoint (Andy's outbound MCP block targets this)
//   VOICE_MCP_BEARER                bearer for the /mcp endpoint
//   VOICE_DISPATCH_BEARER           bearer voice-mcp must present on POST /voice/dispatch
//
// Optional:
//   VOICE_DISPATCH_PORT             default 3202
//   VOICE_DISPATCH_BIND             default 0.0.0.0 (use WG-bind on prod)

import { readEnvFile } from './env.js';

export interface VoiceChannelConfig {
  mcpUrl: string;
  mcpBearer: string;
  dispatchBearer: string;
  dispatchPort: number;
  dispatchBind: string;
}

export function loadVoiceChannelConfig(): VoiceChannelConfig | null {
  const env = readEnvFile([
    'VOICE_MCP_URL',
    'VOICE_MCP_BEARER',
    'VOICE_DISPATCH_BEARER',
    'VOICE_DISPATCH_PORT',
    'VOICE_DISPATCH_BIND',
  ]);
  const mcpUrl = env.VOICE_MCP_URL ?? process.env.VOICE_MCP_URL ?? '';
  const mcpBearer = env.VOICE_MCP_BEARER ?? process.env.VOICE_MCP_BEARER ?? '';
  const dispatchBearer =
    env.VOICE_DISPATCH_BEARER ?? process.env.VOICE_DISPATCH_BEARER ?? '';
  if (!mcpUrl || !mcpBearer || !dispatchBearer) return null;
  return {
    mcpUrl,
    mcpBearer,
    dispatchBearer,
    dispatchPort: Number(
      env.VOICE_DISPATCH_PORT ?? process.env.VOICE_DISPATCH_PORT ?? 3202,
    ),
    dispatchBind:
      env.VOICE_DISPATCH_BIND ?? process.env.VOICE_DISPATCH_BIND ?? '0.0.0.0',
  };
}
