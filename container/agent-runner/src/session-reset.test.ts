import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getUndeliveredMessages } from './db/messages-out.js';
import { getContinuation, setContinuation, setCurrentReplyRoute } from './db/session-state.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { resetSession } from './mcp-tools/session.js';
import { runPollLoop } from './poll-loop.js';
import { archiveClaudeContinuation } from './providers/claude-history.js';
import type { AgentProvider, ProviderEvent, QueryInput } from './providers/types.js';
import { getLastReset, getPendingReset, getResetHistory, recordReset, setPendingReset } from './session-reset.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

let tmp: string;
let handover: string;

function insertMessage(id: string, threadId: string, text = id): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 1, 'channel-1', 'discord', ?, ?)`,
    )
    .run(id, new Date().toISOString(), threadId, JSON.stringify({ text, prompt: text }));
}

function chatTexts(): Array<[string, string | null]> {
  return getUndeliveredMessages()
    .filter((row) => row.kind === 'chat')
    .map((row) => [JSON.parse(row.content).text as string, row.thread_id]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function resultText(result: Awaited<ReturnType<typeof resetSession.handler>>): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
     VALUES ('main', 'Main', 'channel', 'discord', 'channel-1')`,
  );
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-session-'));
  handover = path.join(tmp, 'HANDOVER.md');
  fs.writeFileSync(handover, '# Handover\nNext: phase 2 step 4\n');
});
afterEach(() => {
  closeSessionDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const chatRoute = { inReplyTo: 'm1', channelType: 'discord', platformId: 'channel-1', threadId: 'thread-a' };

describe('reset_session tool guardrails (A3)', () => {
  it('schedules a valid request with the caller route and default resume prompt', async () => {
    setCurrentReplyRoute(chatRoute);
    const result = await resetSession.handler({ handover_path: handover, reason: 'context 125k > 120k' });
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toStartWith('scheduled');
    const pending = getPendingReset()!;
    expect(pending.resume_prompt).toBe(`Read ${handover} and continue.`);
    expect(pending.route?.threadId).toBe('thread-a');
  });

  it('refuses a missing, empty or stale handover', async () => {
    setCurrentReplyRoute(chatRoute);
    let r = await resetSession.handler({ handover_path: path.join(tmp, 'nope.md'), reason: 'x' });
    expect(resultText(r)).toContain('not found');
    fs.writeFileSync(handover, '');
    r = await resetSession.handler({ handover_path: handover, reason: 'x' });
    expect(resultText(r)).toContain('empty');
    fs.writeFileSync(handover, 'content');
    const old = (Date.now() - 31 * 60_000) / 1000;
    fs.utimesSync(handover, old, old);
    r = await resetSession.handler({ handover_path: handover, reason: 'x' });
    expect(resultText(r)).toContain('min old');
    expect(getPendingReset()).toBeNull();
  });

  it('refuses a second reset within 15 min and more than the daily limit', async () => {
    setCurrentReplyRoute(chatRoute);
    recordReset(
      { at: '', reason: 'earlier', handover_path: handover, previous_session: 's0' },
      Date.now() - 5 * 60_000,
    );
    let r = await resetSession.handler({ handover_path: handover, reason: 'x' });
    expect(resultText(r)).toContain('minimum interval');
    const now = Date.now();
    getAgentMailbox().operations.setState(
      'reset_history',
      JSON.stringify([1, 2, 3, 4, 5, 6].map((h) => now - h * 3_600_000)),
    );
    r = await resetSession.handler({ handover_path: handover, reason: 'x' });
    expect(resultText(r)).toContain('limit 6');
  });

  it('refuses in a task run and when a reset is already scheduled', async () => {
    setCurrentReplyRoute({ inReplyTo: 't1', channelType: null, platformId: null, threadId: null });
    let r = await resetSession.handler({ handover_path: handover, reason: 'x' });
    expect(resultText(r)).toContain('task run');
    setCurrentReplyRoute(chatRoute);
    await resetSession.handler({ handover_path: handover, reason: 'first' });
    r = await resetSession.handler({ handover_path: handover, reason: 'second' });
    expect(resultText(r)).toContain('already scheduled');
  });
});

describe('poll loop executes a requested reset (A1, A2)', () => {
  it('ends the query only after the result, clears the continuation and resumes fresh in the same thread', async () => {
    insertMessage('m1', 'thread-a', 'run the study');
    setContinuation('mock', 'old-session');
    const controller = new AbortController();
    const inputs: QueryInput[] = [];
    const archived: string[] = [];
    let firstEnded = false;
    let endedBeforeResult = false;

    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      archiveContinuation: (c) => archived.push(c),
      query: (input) => {
        inputs.push(input);
        const n = inputs.length;
        let ended = false;
        let wake: (() => void) | null = null;
        async function* events(): AsyncGenerator<ProviderEvent> {
          if (n === 1) {
            yield { type: 'init', continuation: 'old-session' };
            const r = await resetSession.handler({ handover_path: handover, reason: 'context 125k > 120k' });
            expect(resultText(r)).toStartWith('scheduled');
            // A2: the request alone must not cut the running turn.
            await new Promise((resolve) => setTimeout(resolve, 600));
            endedBeforeResult = ended;
            yield { type: 'text', text: '<message to="main">Context full, starting fresh.</message>' };
            yield { type: 'result', text: '' };
            while (!ended) await new Promise<void>((resolve) => (wake = resolve));
            firstEnded = true;
            return;
          }
          yield { type: 'init', continuation: 'fresh-session' };
          yield { type: 'text', text: '<message to="main">Continuing with step 4.</message>' };
          yield { type: 'result', text: '' };
          controller.abort();
        }
        return {
          events: events(),
          push: () => {},
          end: () => {
            ended = true;
            wake?.();
          },
          abort: () => {
            ended = true;
            wake?.();
          },
        };
      },
    };

    await runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });

    expect(endedBeforeResult).toBe(false);
    expect(firstEnded).toBe(true);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].continuation).toBe('old-session');
    expect(inputs[1].continuation).toBeUndefined();
    expect(inputs[1].prompt).toContain('origin="session-reset"');
    expect(inputs[1].prompt).toContain(`Read ${handover} and continue.`);
    expect(archived).toEqual(['old-session']);
    expect(getContinuation('mock')).toBe('fresh-session');
    expect(getPendingReset()).toBeNull();
    expect(getLastReset()?.previous_session).toBe('old-session');
    expect(getResetHistory()).toHaveLength(1);
    const texts = chatTexts();
    expect(texts[0]).toEqual(['Context full, starting fresh.', 'thread-a']);
    expect(texts[1][0]).toStartWith('Session reset (reason: context 125k > 120k)');
    expect(texts[1][1]).toBe('thread-a');
    expect(texts[2]).toEqual(['Continuing with step 4.', 'thread-a']);
  });

  it('carries a pending reset over a container restart', async () => {
    setContinuation('mock', 'old-session');
    setPendingReset({
      handover_path: handover,
      resume_prompt: 'Read the handover.',
      reason: 'restart',
      requested_at: new Date().toISOString(),
      route: chatRoute,
    });
    const controller = new AbortController();
    const inputs: QueryInput[] = [];
    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      query: (input) => {
        inputs.push(input);
        async function* events(): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'fresh' };
          yield { type: 'result', text: '' };
          controller.abort();
        }
        return { events: events(), push: () => {}, end: () => {}, abort: () => {} };
      },
    };
    await runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/w',
      signal: controller.signal,
    });
    await waitFor(() => inputs.length === 1);
    expect(inputs[0].continuation).toBeUndefined();
    expect(inputs[0].prompt).toContain('Read the handover.');
  });
});

describe('reset with a follow-up absorbed into the running turn', () => {
  it('still resets once the stream is quiet after the result (phantom queued turn)', async () => {
    process.env.NANOCLAW_RESET_IDLE_MS = '300';
    try {
      insertMessage('m1', 'thread-a', 'run the test');
      setContinuation('mock', 'old-session');
      const controller = new AbortController();
      const inputs: QueryInput[] = [];
      const provider: AgentProvider = {
        registerMemorySessionHook: () => {},
        isSessionInvalid: () => false,
        query: (input) => {
          inputs.push(input);
          const n = inputs.length;
          let ended = false;
          let wake: (() => void) | null = null;
          let pushes = 0;
          async function* events(): AsyncGenerator<ProviderEvent> {
            if (n === 1) {
              yield { type: 'init', continuation: 'old-session' };
              await resetSession.handler({ handover_path: handover, reason: 'absorbed follow-up' });
              insertMessage('m2', 'thread-a', 'ok?');
              await waitFor(() => pushes === 1);
              // The SDK merges the pushed message into this turn: one result only.
              yield { type: 'text', text: '<message to="main">Answered both.</message>' };
              yield { type: 'result', text: '' };
              while (!ended) await new Promise<void>((resolve) => (wake = resolve));
              return;
            }
            yield { type: 'init', continuation: 'fresh' };
            yield { type: 'result', text: '' };
            controller.abort();
          }
          return {
            events: events(),
            push: () => {
              pushes++;
            },
            end: () => {
              ended = true;
              wake?.();
            },
            abort: () => {
              ended = true;
              wake?.();
            },
          };
        },
      };
      await runPollLoop({
        provider,
        providerContract: CONTRACT,
        providerName: 'mock',
        cwd: '/w',
        signal: controller.signal,
      });
      expect(inputs).toHaveLength(2);
      expect(inputs[1].continuation).toBeUndefined();
      expect(getPendingReset()).toBeNull();
    } finally {
      delete process.env.NANOCLAW_RESET_IDLE_MS;
    }
  });
});

describe('archiveClaudeContinuation (A4)', () => {
  it('archives the old transcript into conversations/ and leaves the jsonl in place', () => {
    const prevHome = process.env.HOME;
    const prevConv = process.env.NANOCLAW_CONVERSATIONS_DIR;
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tmp;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
    try {
      const dir = path.join(tmp, '.claude', 'projects', '-workspace-agent');
      fs.mkdirSync(dir, { recursive: true });
      const jsonl = path.join(dir, 'sess-1.jsonl');
      const line = (role: string, content: string) =>
        JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { role, content } });
      fs.writeFileSync(jsonl, [line('user', 'hello'), line('assistant', 'hi there')].join('\n') + '\n');
      const ok = archiveClaudeContinuation({ continuation: 'sess-1', log: () => {} }, { now: () => Date.now() });
      expect(ok).toBe(true);
      expect(fs.readdirSync(path.join(tmp, 'conversations')).length).toBeGreaterThan(0);
      expect(fs.existsSync(jsonl)).toBe(true);
    } finally {
      const restore = (k: string, v: string | undefined) =>
        v === undefined ? delete process.env[k] : (process.env[k] = v);
      restore('HOME', prevHome);
      restore('NANOCLAW_CONVERSATIONS_DIR', prevConv);
      restore('CLAUDE_CONFIG_DIR', prevCfg);
    }
  });
});
