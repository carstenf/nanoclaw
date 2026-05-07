// src/voice-channel/orchestrator.ts
//
// Host-side voice-channel orchestrator. Consolidates everything index.ts
// needs to wire up the voice-channel:
//   - VoiceRespondManager singleton (Andy's promise-correlation map)
//   - tryInjectVoiceRequest helper (host-side IPC injector)
//   - triggerWakeUp helper (insert wake-up sentinel + enqueue message check)
//   - startWsClient(registry) — VoiceMcpClient lifecycle
//   - isWakeUpTurn(prompt) — detector for sentinel-prompt suppression
//   - handleResponseMarker(output, manager) — runAgent-callback hook
//
// Extracted from src/index.ts on 2026-05-07 (refactor 2 of /add-voice-channel
// skill extraction). Goal: index.ts holds ONE import + ONE setup call; all
// voice-related state and helpers live here.

import { storeMessage } from '../db.js';
import { logger } from '../logger.js';
import type { ToolRegistry } from '../mcp-tools/index.js';
import type { RegisteredGroup } from '../types.js';
import { readEnvFile } from '../env.js';
import { VoiceMcpClient } from '../channels/voice-mcp.js';
import { VoiceRespondManager } from './manager.js';
import { wireVoiceChannel, handleVoiceResponseMarker } from './wiring.js';

export interface VoiceOrchestratorDeps {
  /** Returns the current registeredGroups map (read at call time). */
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  /** Drop a VoiceRequestEnvelope into the active main container. */
  sendVoiceRequest: (jid: string, callId: string, prompt: string) => boolean;
  /** Trigger the existing message-check pipeline for a given group. */
  enqueueMessageCheck: (jid: string) => void;
}

export interface VoiceOrchestrator {
  /** Singleton VoiceRespondManager (correlation map for ask_core ↔ voice_respond). */
  manager: VoiceRespondManager;
  /** Inject a voice_request envelope into the active main container. */
  tryInjectVoiceRequest: (callId: string, prompt: string) => boolean;
  /**
   * Insert a `<voice_wake_up>` sentinel message into the main group's DB and
   * trigger the message-check pipeline so the container is up + idle by the
   * time the first ask_core arrives.
   */
  triggerWakeUp: (callId: string, reason: string) => boolean;
  /**
   * runAgent-callback hook. When the container output is a voice_response
   * marker, route it via the VoiceRespondManager and return true; caller
   * then skips channel.sendMessage. Returns false for normal turns.
   */
  handleResponseMarker: typeof handleVoiceResponseMarker;
  /**
   * Detector for the voice wake-up sentinel embedded in the prompt. Used to
   * suppress channel.sendMessage even if the agent ignores the persona's
   * "stay silent" instruction.
   */
  isWakeUpTurn: (prompt: string) => boolean;
  /**
   * Start the long-lived WS client to voice-mcp on Hetzner. No-op when
   * VOICE_MCP_TRIGGERS_URL or VOICE_MCP_BEARER are unset (logged).
   */
  startWsClient: (registry: ToolRegistry, warmupCallId?: string) => void;
}

/**
 * Construct the orchestrator. Pure setup — no side effects until
 * startWsClient is called.
 */
export function setupVoiceOrchestrator(
  deps: VoiceOrchestratorDeps,
): VoiceOrchestrator {
  // VoiceRespondManager + tryInjectVoiceRequest from existing wireVoiceChannel.
  const { manager, tryInjectVoiceRequest } = wireVoiceChannel({
    getMainJid: () => {
      const groups = deps.getRegisteredGroups();
      return Object.entries(groups).find(([, g]) => g.isMain)?.[0] ?? null;
    },
    sendVoiceRequest: deps.sendVoiceRequest,
  });

  /**
   * open_points 2026-04-27 #1: voice-bridge fires this fire-and-forget at
   * /accept time so the main container is up + idle by the time the first
   * ask_core arrives. Inserts a sentinel `<voice_wake_up>` message in the
   * DB and triggers the existing message-check pipeline. If main container
   * is up: pipeline absorbs the turn; persona instruction tells Andy to
   * silently no-op; output suppression in runAgent callback skips
   * Discord/WhatsApp post (sentinel detection on prompt). If main container
   * is down: enqueueMessageCheck spawns it. Either way the container ends
   * up idle-waiting for ask_core within 3-5 s of /accept.
   */
  const triggerWakeUp = (callId: string, reason: string): boolean => {
    const groups = deps.getRegisteredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
    if (!mainEntry) return false;
    const [mainJid, mainGroup] = mainEntry;
    const sentinel = `<voice_wake_up call_id="${callId}" reason="${reason}" />`;
    const now = new Date().toISOString();
    storeMessage({
      id: `wakeup-${callId}-${Date.now()}`,
      chat_jid: mainJid,
      sender: 'voice-bridge',
      sender_name: 'voice-bridge',
      content: sentinel,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
    });
    deps.enqueueMessageCheck(mainJid);
    logger.info(
      {
        event: 'wakeup_sentinel_queued',
        call_id: callId,
        reason,
        main_group: mainGroup.name,
      },
      'voice wake-up sentinel queued + enqueueMessageCheck triggered',
    );
    return true;
  };

  const isWakeUpTurn = (prompt: string): boolean =>
    prompt.includes('<voice_wake_up');

  /**
   * V2.3: long-lived WebSocket client to voice-mcp on Hetzner — pattern
   * identical to channels/discord.ts: NanoClaw initiates outbound, holds
   * the connection open, receives push triggers, replies. Replaces
   * Bridge → NanoClaw:3201 inbound in V2.2 with NanoClaw → voice-mcp
   * outbound. NanoClaw never binds an inbound voice-mcp port.
   */
  const startWsClient = (registry: ToolRegistry): void => {
    const voiceMcpEnv = readEnvFile([
      'VOICE_MCP_TRIGGERS_URL',
      'VOICE_MCP_BEARER',
    ]);
    const url =
      process.env.VOICE_MCP_TRIGGERS_URL ??
      voiceMcpEnv.VOICE_MCP_TRIGGERS_URL ??
      '';
    const bearer =
      process.env.VOICE_MCP_BEARER ?? voiceMcpEnv.VOICE_MCP_BEARER ?? '';
    if (!url || !bearer) {
      logger.info({
        event: 'voice_mcp_client_disabled',
        reason: 'VOICE_MCP_TRIGGERS_URL or VOICE_MCP_BEARER unset',
      });
      return;
    }
    const client = new VoiceMcpClient({
      url,
      bearer,
      registry,
      voiceRespondManager: manager,
      tryInjectVoiceRequest,
      warmupContainer: () => triggerWakeUp('voice-mcp-warmup', 'warmup'),
    });
    client.start();
  };

  return {
    manager,
    tryInjectVoiceRequest,
    triggerWakeUp,
    handleResponseMarker: handleVoiceResponseMarker,
    isWakeUpTurn,
    startWsClient,
  };
}
