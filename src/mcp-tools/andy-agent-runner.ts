/**
 * andy-agent-runner.ts
 *
 * Wraps runContainerAgent for voice-initiated Andy queries.
 * - Loads the ask-core-andy SKILL.md, prepends it to the prompt.
 * - Fetches the main-group row from DB (is_main=1).
 * - Uses streaming onOutput to capture the container's final result and reset
 *   the internal container-runner timeout on activity (avoids false timeouts
 *   during cold container starts that take 60-120s).
 * - Parses the last JSON block from the result string: {voice_short, discord_long}.
 * - Enforces max-3-sentences on voice_short; truncates if longer.
 * - Provides semantic fallback strings for every failure path.
 *
 * DI: all external dependencies injectable for testing without real containers.
 */

import { runContainerAgent } from '../container-runner.js';
import { logger } from '../logger.js';
import { loadSkill } from './skill-loader.js';
import type { ContainerOutput } from '../container-runner.js';
import type { RegisteredGroup } from '../types.js';
import type { SkillLoadResult } from './skill-loader.js';
import { ASK_CORE_ANDY_TIMEOUT_MS } from '../config.js';
import { getMainGroup } from '../db.js';

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export interface AndyVoiceResult {
  /** Max 3 sentences, post-parsed and truncated. */
  voice_short: string;
  /** Optional long-form for Discord, or null. */
  discord_long: string | null;
  /** Wall-clock ms from start to container exit (or timeout). */
  container_latency_ms: number;
}

export interface AndyRunnerDeps {
  /** Override runContainerAgent (for tests). */
  runContainer?: (
    group: RegisteredGroup & { jid: string },
    input: {
      prompt: string;
      sessionId?: string;
      groupFolder: string;
      chatJid: string;
      isMain: boolean;
      isScheduledTask?: boolean;
    },
    onProcess: (proc: unknown, name: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => Promise<ContainerOutput>;
  /** Returns the main RegisteredGroup row (jid included), or null if not found. */
  loadMainGroup?: () => (RegisteredGroup & { jid: string }) | null;
  /** Load skill SKILL.md by topic. */
  loadSkill?: (topic: string) => Promise<SkillLoadResult>;
  /** Override Date.now() for latency calculation (tests). */
  now?: () => number;
  /** Override timeout in ms. Default: ASK_CORE_ANDY_TIMEOUT_MS. */
  timeoutMs?: number;
}

// --------------------------------------------------------------------------
// Sentence truncation
// --------------------------------------------------------------------------

/**
 * Count sentence-ending punctuation marks in text.
 * Uses /[.!?]/g — each match counts as one sentence end.
 */
function countSentenceEnds(text: string): number {
  return (text.match(/[.!?]/g) ?? []).length;
}

/**
 * Truncate text to at most maxSentences sentence-ends.
 * Splits on sentence-enders and reassembles.
 */
function truncateToMaxSentences(text: string, maxSentences = 3): string {
  if (countSentenceEnds(text) <= maxSentences) return text;

  // Walk through the string, collecting up to maxSentences sentence-ends.
  let count = 0;
  let cutIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (/[.!?]/.test(text[i])) {
      count++;
      if (count === maxSentences) {
        cutIdx = i + 1;
        break;
      }
    }
  }

  return cutIdx === -1 ? text : text.slice(0, cutIdx).trim();
}

// --------------------------------------------------------------------------
// JSON parsing from container stdout/result
// --------------------------------------------------------------------------

interface AndyJsonOutput {
  voice_short: string;
  discord_long: string | null;
}

/**
 * Find the last `{...}` block in text that is valid JSON containing
 * voice_short. Returns null if no such block found.
 */
function parseLastJsonBlock(text: string): AndyJsonOutput | null {
  // Walk backwards through the string looking for '}' ... '{' pairs
  let end = text.lastIndexOf('}');
  while (end !== -1) {
    // Find the matching '{' — scan backwards from end
    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{') {
        depth--;
        if (depth === 0) {
          start = i;
          break;
        }
      }
    }

    if (start !== -1) {
      try {
        const candidate = text.slice(start, end + 1);
        const parsed = JSON.parse(candidate);
        if (typeof parsed.voice_short === 'string') {
          return {
            voice_short: parsed.voice_short,
            discord_long:
              typeof parsed.discord_long === 'string'
                ? parsed.discord_long
                : null,
          };
        }
      } catch {
        // Not valid JSON — try earlier occurrence
      }
    }

    // Move to previous '}'
    end = text.lastIndexOf('}', end - 1);
  }

  return null;
}

// --------------------------------------------------------------------------
// Main export
// --------------------------------------------------------------------------

/**
 * Run Andy (the main-group container agent) for a voice-initiated request.
 *
 * Uses the onOutput streaming callback so runContainerAgent resets its internal
 * timeout on each output marker — this prevents false timeouts during cold
 * container starts (60-120s) while still capturing the actual result text.
 *
 * The app-level timeout (ASK_CORE_ANDY_TIMEOUT_MS, default 90s) is a race
 * against the container run to protect against containers that never produce
 * any output at all (hang / OOM / spawn failure).
 *
 * @param request  The user's voice request text.
 * @param deps     Injected dependencies (for testing).
 */
export async function runAndyForVoice(
  request: string,
  deps: AndyRunnerDeps = {},
): Promise<AndyVoiceResult> {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? ASK_CORE_ANDY_TIMEOUT_MS;
  const _runContainer = (deps.runContainer ??
    runContainerAgent) as typeof runContainerAgent;
  const _loadMainGroup = deps.loadMainGroup ?? getMainGroup;
  const _loadSkill = deps.loadSkill ?? loadSkill;

  const startTs = now();
  // Phase 05.6 telemetry: per-phase timing for ask_core/Andy. Logged at info
  // level under event=`andy_telemetry` with `phase` and ms_since_start so the
  // call timeline can be reconstructed via grep/jq.
  const telemetry = (phase: string, extra: Record<string, unknown> = {}) => {
    logger.info(
      {
        event: 'andy_telemetry',
        phase,
        ms_since_start: now() - startTs,
        ...extra,
      },
      `andy_telemetry phase=${phase}`,
    );
  };
  telemetry('runner_start');

  // 1. Load skill body
  const skill = await _loadSkill('andy').catch(() => ({
    exists: false,
    body: null,
    path: '',
  }));
  telemetry('skill_loaded', { exists: skill.exists });

  if (!skill.exists || !skill.body) {
    logger.warn(
      { event: 'andy_runner_skill_missing' },
      'ask-core-andy skill not configured',
    );
    return {
      voice_short: 'Andy-Skill ist nicht konfiguriert.',
      discord_long: null,
      container_latency_ms: now() - startTs,
    };
  }

  // 2. Fetch main-group row
  const mainGroup = _loadMainGroup();
  telemetry('main_group_loaded', { found: !!mainGroup });
  if (!mainGroup) {
    logger.warn(
      { event: 'andy_runner_no_main_group' },
      'No main group found in DB',
    );
    return {
      voice_short: 'Andy ist gerade nicht erreichbar. Bitte nochmal versuchen.',
      discord_long: null,
      container_latency_ms: now() - startTs,
    };
  }

  // 3. Build container input — prepend skill body to ensure voice format rules are visible.
  // No sessionId: voice requests always start a fresh conversation. Passing a new UUID
  // would cause the agent-runner to attempt session resume, which fails for non-existent IDs.
  // Use mainGroup.folder (e.g. 'whatsapp_main') — NOT the hardcoded string 'main'.
  const prompt = `${skill.body}\n\n=== REQUEST ===\n${request}`;
  const containerInput = {
    prompt,
    groupFolder: mainGroup.folder,
    chatJid: mainGroup.jid,
    isMain: true,
    isScheduledTask: false as const,
  };

  // 4. Run container with streaming onOutput callback.
  // We collect the last successful result from streaming output markers.
  // The onOutput callback causes runContainerAgent to reset its internal
  // idle-timeout on each output marker, preventing false timeouts during
  // cold starts. Our outer race timeout fires only if no output arrives at all.
  let streamedResult: string | null = null;
  let streamError: string | null = null;
  let firstChunkLogged = false;
  let firstSuccessLogged = false;

  telemetry('runcontainer_call');
  let output: ContainerOutput;
  try {
    output = await Promise.race([
      _runContainer(
        mainGroup,
        containerInput,
        (_proc, name) => {
          telemetry('container_spawned', { container_name: name });
          logger.info(
            { event: 'andy_container_spawned', containerName: name },
            'Andy container spawned for voice request',
          );
        },
        async (chunk: ContainerOutput) => {
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            telemetry('first_stream_chunk', { status: chunk.status });
          }
          // Collect the last successful result from streaming output markers
          if (chunk.status === 'success' && chunk.result) {
            if (!firstSuccessLogged) {
              firstSuccessLogged = true;
              telemetry('first_success_chunk', {
                result_len: chunk.result.length,
              });
            }
            streamedResult = chunk.result;
          } else if (chunk.status === 'error' && chunk.error) {
            streamError = chunk.error;
          }
        },
      ),
      new Promise<ContainerOutput>((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 'error' as const,
              result: null,
              error: 'timeout',
            }),
          timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    logger.warn(
      { event: 'andy_container_spawn_error', err },
      'Container spawn error for voice Andy',
    );
    return {
      voice_short: 'Ich erreiche Andy gerade nicht. Bitte nochmal versuchen.',
      discord_long: null,
      container_latency_ms: now() - startTs,
    };
  }

  const latency = now() - startTs;
  telemetry('runcontainer_returned', {
    output_status: output.status,
    output_error: output.error ?? null,
    has_streamed_result: streamedResult !== null,
    total_ms: latency,
  });

  // 5. Check if we received streaming output (even if container exited with error after)
  // In streaming mode, runContainerAgent returns {status:'success', result:null} on normal
  // completion. We prefer streamedResult over output.result.
  const resultText = streamedResult ?? output.result ?? '';

  // 5a. Handle timeout
  if (output.status === 'error' && output.error === 'timeout') {
    // If we got streamed output despite the race timeout, use it
    if (streamedResult) {
      logger.info(
        { event: 'andy_using_streamed_result_after_race_timeout' },
        'Race timeout fired but streamed result available — using it',
      );
      // Fall through to parse streamedResult below
    } else {
      logger.warn(
        { event: 'andy_container_timeout', timeoutMs },
        'Andy container timed out with no output',
      );
      return {
        voice_short: 'Das dauert noch. Ich melde mich mit Details in Discord.',
        discord_long: null,
        container_latency_ms: latency,
      };
    }
  }

  // 5b. Handle container error (non-timeout)
  if (output.status === 'error' && output.error !== 'timeout') {
    // If we somehow got a streamed result before the error, use it
    if (streamedResult) {
      logger.info(
        { event: 'andy_using_streamed_result_after_container_error' },
        'Container errored but streamed result available — using it',
      );
      // Fall through to parse below
    } else if (streamError) {
      logger.warn(
        { event: 'andy_container_stream_error', error: streamError },
        'Andy container returned stream error',
      );
      return {
        voice_short: 'Ich erreiche Andy gerade nicht. Bitte nochmal versuchen.',
        discord_long: null,
        container_latency_ms: latency,
      };
    } else {
      logger.warn(
        { event: 'andy_container_error', error: output.error },
        'Andy container returned error',
      );
      return {
        voice_short: 'Ich erreiche Andy gerade nicht. Bitte nochmal versuchen.',
        discord_long: null,
        container_latency_ms: latency,
      };
    }
  }

  // 6. Parse JSON from result text
  const parsed = parseLastJsonBlock(resultText);

  if (!parsed) {
    logger.warn(
      { event: 'andy_json_parse_fail', resultLen: resultText.length },
      'No valid JSON block found in Andy container output',
    );
    // Fallback: use first 200 chars of result
    const fallbackText =
      resultText.trim().slice(0, 200) || 'Keine Antwort von Andy.';
    return {
      voice_short: fallbackText,
      discord_long: null,
      container_latency_ms: latency,
    };
  }

  // 7. Enforce max-3-sentences on voice_short
  const voice_short = truncateToMaxSentences(parsed.voice_short, 3);

  return {
    voice_short,
    discord_long: parsed.discord_long,
    container_latency_ms: latency,
  };
}
