// Phase 4 Plan 04-02 Task 2: voice.reset_monthly_cap MCP handler — unit tests.
// RED during this plan's task 2b; GREEN after the handler is landed.
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceResetMonthlyCap,
  VoiceResetMonthlyCapDeps,
} from './voice-reset-monthly-cap.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vreset-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-cost.jsonl');
const BASE_NOW = new Date('2026-04-19T12:00:00Z').getTime();

function makeDeps(
  overrides: Partial<VoiceResetMonthlyCapDeps> = {},
): VoiceResetMonthlyCapDeps & {
  routerStore: Map<string, string>;
} {
  const store = new Map<string, string>();
  const deps: VoiceResetMonthlyCapDeps & { routerStore: Map<string, string> } = {
    routerStore: store,
    getRouterState: (k) => store.get(k),
    setRouterState: (k, v) => {
      store.set(k, v);
    },
    jsonlPath: JSONL_PATH(),
    now: () => BASE_NOW,
    ...overrides,
  };
  return deps;
}

describe('makeVoiceResetMonthlyCap (04-02 COST-03 manual reset)', () => {
  it('happy path: clears voice_channel_suspended flag, returns was_suspended=true', async () => {
    const deps = makeDeps();
    deps.routerStore.set('voice_channel_suspended', '1');
    const handler = makeVoiceResetMonthlyCap(deps);

    const result = (await handler({
      reason: 'Monatswechsel — budget reset',
      authorized_by: 'carsten_cli',
    })) as {
      ok: true;
      result: { reset: boolean; was_suspended: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.result.reset).toBe(true);
    expect(result.result.was_suspended).toBe(true);
    expect(deps.routerStore.get('voice_channel_suspended')).toBe('0');
  });

  it('when not suspended: still writes 0, returns was_suspended=false', async () => {
    const deps = makeDeps();
    const handler = makeVoiceResetMonthlyCap(deps);

    const result = (await handler({
      reason: 'preemptive reset',
      authorized_by: 'carsten_cli',
    })) as { ok: true; result: { reset: boolean; was_suspended: boolean } };

    expect(result.result.reset).toBe(true);
    expect(result.result.was_suspended).toBe(false);
    expect(deps.routerStore.get('voice_channel_suspended')).toBe('0');
  });

  it('missing reason → BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceResetMonthlyCap(deps);
    await expect(
      handler({ authorized_by: 'carsten_cli' } as unknown),
    ).rejects.toThrow(BadRequestError);
  });

  it('missing authorized_by → BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceResetMonthlyCap(deps);
    await expect(
      handler({ reason: 'something' } as unknown),
    ).rejects.toThrow(BadRequestError);
  });

  it('JSONL: writes monthly_cap_reset audit row with before/after/reason/authorized_by', async () => {
    const deps = makeDeps();
    deps.routerStore.set('voice_channel_suspended', '1');
    const handler = makeVoiceResetMonthlyCap(deps);

    await handler({
      reason: 'monthly budget refresh',
      authorized_by: 'carsten_cli',
    });

    const raw = fs.readFileSync(JSONL_PATH(), 'utf8');
    const entry = JSON.parse(raw.trim().split('\n').pop()!);
    expect(entry.event).toBe('monthly_cap_reset');
    expect(entry.tool).toBe('voice.reset_monthly_cap');
    expect(entry.before).toBe('1');
    expect(entry.after).toBe('0');
    expect(entry.reason).toBe('monthly budget refresh');
    expect(entry.authorized_by).toBe('carsten_cli');
    expect(entry).toHaveProperty('at_ms');
  });
});
