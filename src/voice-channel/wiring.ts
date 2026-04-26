/**
 * voice-channel/wiring.ts
 *
 * Glue between the host process and the voice-channel module.
 *
 * - `wireVoiceChannel(deps)` constructs the singleton VoiceRespondManager and
 *   the host-side `tryInjectVoiceRequest` helper, ready to hand to the MCP
 *   tool registry.
 * - `handleVoiceResponseMarker(output, manager)` is the runAgent-callback
 *   hook: when the container emits a voice_response marker, route it to the
 *   manager and signal the caller to skip the normal channel.sendMessage
 *   path. Returns true when handled.
 */
import { logger } from '../logger.js';
import type { ContainerOutput } from '../container-runner.js';
import { VoiceRespondManager } from './manager.js';

export interface VoiceChannelDeps {
  /**
   * Returns the jid of the active main container (whatsapp_main), or null
   * when no main container is running. Provided by the host because group
   * registration lives outside the voice-channel module.
   */
  getMainJid: () => string | null;
  /**
   * Drop a VoiceRequestEnvelope into the active main container's input/.
   * Returns true if the file was written, false otherwise. Wraps
   * GroupQueue.sendVoiceRequest — owned by the host because path resolution
   * needs group state.
   */
  sendVoiceRequest: (jid: string, callId: string, prompt: string) => boolean;
}

export interface VoiceChannelWiring {
  manager: VoiceRespondManager;
  /**
   * Inject a voice_request into the active whatsapp_main container.
   * Returns false if no main container is active (caller — voice-ask-core —
   * then returns a graceful "Andy not reachable" answer; NO --rm fallback).
   */
  tryInjectVoiceRequest: (callId: string, prompt: string) => boolean;
}

export function wireVoiceChannel(deps: VoiceChannelDeps): VoiceChannelWiring {
  const manager = new VoiceRespondManager();
  const tryInjectVoiceRequest = (callId: string, prompt: string): boolean => {
    const jid = deps.getMainJid();
    if (!jid) return false;
    return deps.sendVoiceRequest(jid, callId, prompt);
  };
  return { manager, tryInjectVoiceRequest };
}

/**
 * runAgent-callback hook: if the container output is a voice_response marker,
 * resolve the matching VoiceRespondManager promise and return true. Caller
 * should then `return` from its callback (skip channel.sendMessage). Returns
 * false for normal turns — caller continues with the regular output path.
 *
 * Strips <internal>...</internal> reasoning blocks the agent uses for
 * pre-answer scratch work.
 */
export function handleVoiceResponseMarker(
  output: ContainerOutput,
  manager: VoiceRespondManager,
): boolean {
  if (
    output.status !== 'voice_response' ||
    !output.call_id ||
    !output.result
  ) {
    return false;
  }
  const raw =
    typeof output.result === 'string'
      ? output.result
      : JSON.stringify(output.result);
  const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  logger.info(
    {
      event: 'voice_response_marker_received',
      call_id: output.call_id,
      length: text.length,
    },
    'voice_response marker — routing to VoiceRespondManager',
  );
  manager.resolve(output.call_id, {
    voice_short: text,
    discord_long: output.discord_long ?? null,
  });
  return true;
}
