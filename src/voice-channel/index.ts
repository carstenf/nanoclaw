/**
 * voice-channel/ — public API barrel.
 *
 * Voice-channel turn lifecycle, isolated from the rest of NanoClaw:
 *   - protocol.ts: IPC envelope + marker types (host↔container contract)
 *   - manager.ts: VoiceRespondManager (Promise correlation by call_id)
 *   - wiring.ts: wireVoiceChannel + handleVoiceResponseMarker host glue
 *
 * Consumers (mcp-tools/voice-ask-core, mcp-tools/voice-respond, src/index)
 * should import from here, not the inner files.
 */
export {
  buildVoiceRequestEnvelope,
  type VoiceRequestEnvelope,
  type VoiceResponseMarker,
} from './protocol.js';
export {
  VoiceRespondManager,
  VoiceRespondTimeoutError,
  VoiceRespondNotFoundError,
  type AndyVoicePayload,
} from './manager.js';
export {
  wireVoiceChannel,
  handleVoiceResponseMarker,
  type VoiceChannelDeps,
  type VoiceChannelWiring,
} from './wiring.js';
