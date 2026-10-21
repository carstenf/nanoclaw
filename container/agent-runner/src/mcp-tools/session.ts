/**
 * Session tools: reset_session (agent-triggered fresh start with handover).
 *
 * The tool only validates and records the request; the poll loop performs
 * the reset after the current turn (and any queued turns) has finished.
 * Acts on the calling session only, so it needs no admin approval.
 */
import { getCurrentReplyRoute } from '../db/session-state.js';
import { checkHandover, checkRateLimits, getPendingReset, setPendingReset } from '../session-reset.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function refused(reason: string) {
  log(`reset_session refused: ${reason}`);
  return { content: [{ type: 'text' as const, text: `Refused: ${reason}` }], isError: true };
}

export const resetSession: McpToolDefinition = {
  tool: {
    name: 'reset_session',
    description:
      'End your own session and start fresh from a handover file, instead of relying on auto-compaction. ' +
      'Write the handover first and make sure no background subagent is still running. The reset happens ' +
      'after your current turn ends; the fresh session then starts with the resume prompt. Returns "scheduled" or a refusal.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        handover_path: {
          type: 'string',
          description: 'Absolute path of the handover file (must exist, be non-empty, and be recent).',
        },
        resume_prompt: {
          type: 'string',
          description: 'First input of the fresh session. Default: "Read <handover_path> and continue."',
        },
        reason: { type: 'string', description: 'Short reason, e.g. "context 125k > 120k, phase 2 step 4".' },
      },
      required: ['handover_path', 'reason'],
    },
  },
  async handler(args) {
    const handoverPath = typeof args.handover_path === 'string' ? args.handover_path.trim() : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!handoverPath) return refused('handover_path is required');
    if (!reason) return refused('reason is required (short text)');
    const resumePrompt =
      (typeof args.resume_prompt === 'string' && args.resume_prompt.trim()) || `Read ${handoverPath} and continue.`;

    const route = getCurrentReplyRoute();
    if (!route || route.channelType === null) {
      return refused('this is a task run — task sessions are already one-shot');
    }
    const pending = getPendingReset();
    if (pending) return refused(`a reset is already scheduled (reason: ${pending.reason})`);

    const handoverProblem = checkHandover(handoverPath);
    if (handoverProblem) return refused(handoverProblem);
    const rateProblem = checkRateLimits();
    if (rateProblem) return refused(rateProblem);

    setPendingReset({
      handover_path: handoverPath,
      resume_prompt: resumePrompt,
      reason,
      requested_at: new Date().toISOString(),
      route,
    });
    log(`reset_session scheduled: ${reason}`);
    return ok(
      'scheduled — the session resets after this turn ends. Finish your turn now with a short note to the user; ' +
        `the fresh session starts with: "${resumePrompt}"`,
    );
  },
};

registerTools([resetSession]);
