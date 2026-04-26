/**
 * voice-channel/protocol.ts
 *
 * Wire-format contract between the NanoClaw host process and the in-container
 * agent-runner for voice-channel turns. Two envelopes cross the IPC boundary:
 *
 *   1. host → container: VoiceRequestEnvelope (file in IPC input/)
 *   2. container → host: VoiceResponseMarker (in agent-runner output)
 *
 * The container side lives in a separate TypeScript project
 * (`container/agent-runner/`) and cannot import this file at build time.
 * It re-declares these shapes inline. Keep both ends in sync — when changing
 * a field here, also update:
 *   - container/agent-runner/src/index.ts: drainIpcInput() (reads the request)
 *   - container/agent-runner/src/index.ts: writeOutput() (emits the marker)
 *   - src/container-runner.ts: ContainerOutput type (parses the marker)
 */

/**
 * IPC envelope dropped into a container's input/ directory by the host to ask
 * Andy to answer a voice-channel turn. The container's agent-runner detects
 * `type === 'voice_request'`, remembers the call_id, and routes the next
 * `result` through the voice_response marker.
 */
export interface VoiceRequestEnvelope {
  type: 'voice_request';
  call_id: string;
  prompt: string;
}

/**
 * Build a VoiceRequestEnvelope. Used by group-queue.sendVoiceRequest() so the
 * envelope shape lives in one place.
 */
export function buildVoiceRequestEnvelope(
  callId: string,
  prompt: string,
): VoiceRequestEnvelope {
  return { type: 'voice_request', call_id: callId, prompt };
}

/**
 * Output marker emitted by the container's agent-runner when the just-finished
 * turn was driven by a VoiceRequestEnvelope. The host (runAgent callback)
 * routes this to VoiceRespondManager.resolve() instead of the channel's
 * normal sendMessage() path.
 *
 * Shape matches the ContainerVoiceResponse variant of src/container-runner.ts
 * ContainerOutput discriminated union. Keep all three (here, container-runner,
 * agent-runner inline copy) in sync.
 */
export interface VoiceResponseMarker {
  status: 'voice_response';
  call_id: string;
  result: string | null;
  discord_long?: string | null;
}
