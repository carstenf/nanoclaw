import fs from 'fs';

import { OneCLI } from '@onecli-sh/sdk';

import { DATA_DIR, ONECLI_URL } from '../config.js';
import { logger } from '../logger.js';

import { SlowBrainSessionManager } from './slow-brain-session.js';
import type { VoiceTriggersInitInput } from './voice-triggers-init.js';
import type { VoiceTriggersTranscriptInput } from './voice-triggers-transcript.js';
import { VoiceRespondManager } from '../voice-channel/index.js';
import { registerVoiceTools } from '../voice-channel/register-tools.js';
// Phase 05.6 Plan 01 Task 4 — REQ-DIR-17 dispatch-path gateway.
import {
  checkMidCallMutation,
  type ToolMeta,
} from '../voice-mid-call-gateway.js';

/**
 * Fetch OneCLI CA certificate and write it to the path set in NODE_EXTRA_CA_CERTS.
 * Must be called before the first TLS connection through the OneCLI proxy.
 * Fails silently — if OneCLI is unreachable, inference will fail at call time.
 */
export async function ensureOneCLICaCert(): Promise<void> {
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!caPath) return;
  // If file already exists, no need to re-fetch
  if (fs.existsSync(caPath)) return;
  try {
    const onecli = new OneCLI({ url: ONECLI_URL });
    const config = await onecli.getContainerConfig();
    fs.writeFileSync(caPath, config.caCertificate);
    logger.info({ event: 'onecli_ca_cert_written', path: caPath });
  } catch (err) {
    logger.warn({ event: 'onecli_ca_cert_write_failed', err });
  }
}

export type ToolHandler = (args: unknown) => Promise<unknown>;

export class UnknownToolError extends Error {
  readonly code = 'unknown_tool';
  constructor(public readonly toolName: string) {
    super(`unknown_tool: ${toolName}`);
    this.name = 'UnknownToolError';
  }
}

/**
 * Per-tool registration entry. The optional `meta.mutating` flag drives the
 * REQ-DIR-17 dispatch-path gateway (Phase 05.6 Plan 01 Task 4): mutating
 * tools invoked while a call is active are rejected with
 * `{ ok: false, error: 'mid_call_mutation_forbidden' }` BEFORE the handler runs.
 */
export interface ToolRegistration {
  handler: ToolHandler;
  meta: ToolMeta;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();

  /**
   * Backward-compat additive signature. Existing callers that omit `meta`
   * implicitly register the tool as non-mutating (the safe default —
   * read-only tools always pass the gateway).
   */
  register(name: string, handler: ToolHandler, meta: ToolMeta = {}): void {
    this.tools.set(name, { handler, meta });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async invoke(name: string, args: unknown): Promise<unknown> {
    const reg = this.tools.get(name);
    if (!reg) throw new UnknownToolError(name);

    // REQ-DIR-17 dispatch-path gateway (Phase 05.6 Plan 01 Task 4).
    // Read call_id off the args object if present; absent or non-string
    // call_id → null → gateway treats as no-call-correlation → ALLOWED.
    const callId =
      args && typeof args === 'object' && 'call_id' in args
        ? (args as { call_id: unknown }).call_id
        : null;
    const callIdStr = typeof callId === 'string' ? callId : null;
    const decision = checkMidCallMutation(callIdStr, name, reg.meta);
    if (!decision.allowed) {
      return { ok: false, error: decision.reason };
    }
    return reg.handler(args);
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }
}

export interface RegistryDeps {
  dataDir?: string;
  log?: Pick<typeof logger, 'info' | 'warn'>;
  /** Idle sweep interval in ms. Default: 60000. Pass 0 to disable (useful in tests). */
  sweepIntervalMs?: number;
  /** Inject a session manager (useful in tests to avoid real OneCLI calls). */
  sessionManager?: SlowBrainSessionManager;
  /** Discord send callback — injected from index.ts to reuse existing DiscordChannel gateway. */
  sendDiscordMessage?: (
    channelId: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Main-group lookup callback — returns {folder, jid} for is_main=1 group, or null. */
  getMainGroupAndJid?: () => { folder: string; jid: string } | null;
  /**
   * Plan 05-02 Task 5: external ActiveSessionTracker instance.
   * When provided, voice_notify_user uses this tracker instead of creating its own.
   * index.ts creates one at startup and calls tracker.recordActivity() on every
   * inbound message, then passes the same instance here so the routing has real data.
   */
  activeSessionTracker?: import('../channels/active-session-tracker.js').ActiveSessionTracker;
  /**
   * Phase 05.5 Plan 01 Task 4 (D-24): DI seam for the container-agent reasoning
   * layer. Phase 05.5 keeps the defaults as no-op stubs (see registration below);
   * Phase 05.6 replaces with a real `src/container-runner.ts` integration.
   * Tests inject mocks for behavioural verification.
   */
  invokeAgent?: (
    input: VoiceTriggersInitInput,
  ) => Promise<{ instructions: string }>;
  invokeAgentTurn?: (
    input: VoiceTriggersTranscriptInput,
  ) => Promise<{ instructions_update: string | null }>;
  /**
   * Phase 05.6-04 follow-up: shared VoiceRespondManager for the
   * existing-container voice-request path. The voice_respond MCP tool
   * resolves pending Promises in this manager; voice-ask-core (topic='andy')
   * registers them. Inject the same instance for both. If omitted,
   * buildDefaultRegistry creates one internally.
   */
  voiceRespondManager?: VoiceRespondManager;
  /**
   * Phase 05.6-04 follow-up: drop a voice_request IPC envelope into the
   * active main container. Returns true if the container was active and the
   * file was written; false if no active container — voice-ask-core then
   * returns a graceful "Andy nicht erreichbar" (NO --rm fallback to avoid
   * orphan-container leaks across NanoClaw restarts). Wired in NanoClaw
   * index.ts as `(callId, prompt) => queue.sendVoiceRequest(mainJid, ...)`.
   */
  tryInjectVoiceRequest?: (callId: string, prompt: string) => boolean;
  /**
   * open_points 2026-04-27 #1: pre-warm the main container at voice /accept
   * time. Inserts a `<voice_wake_up>` sentinel message into the main group
   * DB and triggers `enqueueMessageCheck`, so the container spawns if down
   * or the wake-up turn is absorbed if up. Returns true when scheduled,
   * false if no main group is registered. Wired in NanoClaw index.ts.
   */
  triggerWakeUp?: (callId: string, reason: string) => boolean;
}

// Phase 05.5 Plan 01 Task 4 (REQ-INFRA-16, D-11): voiceTriggerQueue
// singleton moved to src/voice-channel/register-tools.ts as part of the
// /add-voice-channel skill extraction (refactor 2026-05-06). Re-exported
// here so existing importers continue to work without changes.
export { voiceTriggerQueue } from '../voice-channel/register-tools.js';

export interface RegistryHandle {
  registry: ToolRegistry;
  /** Call to stop the background idle-sweep timer. */
  stop: () => void;
}

/**
 * Build the default MCP tool registry with Slow-Brain session manager wired in.
 * Returns registry + stop() to clean up the setInterval when process exits.
 */
export function buildDefaultRegistry(deps: RegistryDeps = {}): ToolRegistry {
  const registry = new ToolRegistry();

  // Ensure the OneCLI CA cert is written before the first inference call.
  // Fire-and-forget: if OneCLI is unreachable at startup, inference will
  // log a warning at call time.
  if (!deps.sessionManager) {
    void ensureOneCLICaCert();
  }

  const sessionManager = deps.sessionManager ?? new SlowBrainSessionManager();

  // Start idle-sweep on a 60s interval (clearable via handle.stop)
  const sweepMs = deps.sweepIntervalMs ?? 60000;
  if (sweepMs > 0) {
    const interval = setInterval(() => {
      sessionManager.idleSweep();
    }, sweepMs);
    // Allow Node process to exit even if timer is still active
    if (interval.unref) interval.unref();
  }

  // Voice-channel tool registrations. Single line so the /add-voice-channel
  // skill can install/remove this with the matching import + voice-channel/
  // directory. When the skill is uninstalled, both the import above and
  // this call disappear; the rest of buildDefaultRegistry stays intact.
  registerVoiceTools(registry, { ...deps, sessionManager });

  return registry;
}

// (legacy buildDefaultRegistry body removed — all voice-tool registrations
// have moved to src/voice-channel/register-tools.ts; the function above is
// the new shared shell.)

