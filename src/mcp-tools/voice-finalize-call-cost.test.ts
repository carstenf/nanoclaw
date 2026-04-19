// Phase 4 (INFRA-06): voice.finalize_call_cost MCP handler — unit tests.
// RED during Wave-0: handler does not exist yet; Task 4 turns this GREEN.
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceFinalizeCallCost,
  VoiceFinalizeCallCostDeps,
} from './voice-finalize-call-cost.js';
import type { VoiceCallCostRow } from '../cost-ledger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfinalize-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-cost.jsonl');
const BASE_NOW = new Date('2026-04-19T12:00:00Z').getTime();

function makeDeps(
  overrides: Partial<VoiceFinalizeCallCostDeps> = {},
  sumResult: { sum_eur: number; count: number } = { sum_eur: 0.42, count: 7 },
): VoiceFinalizeCallCostDeps & { captured: VoiceCallCostRow | null } {
  const deps: VoiceFinalizeCallCostDeps & { captured: VoiceCallCostRow | null } = {
    captured: null,
    upsertCallCost: (row) => {
      deps.captured = row;
    },
    sumTurnCosts: () => sumResult,
    jsonlPath: JSONL_PATH(),
    now: () => BASE_NOW,
    ...overrides,
  };
  return deps;
}

describe('makeVoiceFinalizeCallCost (INFRA-06)', () => {
  it('happy path: upserts call cost row with SUM from sumTurnCosts, returns {finalized:true}', async () => {
    const deps = makeDeps({}, { sum_eur: 0.42, count: 7 });
    const handler = makeVoiceFinalizeCallCost(deps);

    const result = (await handler({
      call_id: 'c1',
      case_type: 'case_6a',
      started_at: '2026-04-19T11:59:00Z',
      ended_at: '2026-04-19T12:01:30Z',
      terminated_by: 'counterpart_bye',
      soft_warn_fired: 0,
    })) as {
      ok: true;
      result: { finalized: boolean; cost_eur: number; turn_count: number };
    };

    expect(result.ok).toBe(true);
    expect(result.result.finalized).toBe(true);
    expect(result.result.cost_eur).toBeCloseTo(0.42, 5);
    expect(result.result.turn_count).toBe(7);

    expect(deps.captured).not.toBeNull();
    expect(deps.captured!.call_id).toBe('c1');
    expect(deps.captured!.case_type).toBe('case_6a');
    expect(deps.captured!.cost_eur).toBeCloseTo(0.42, 5);
    expect(deps.captured!.turn_count).toBe(7);
    expect(deps.captured!.terminated_by).toBe('counterpart_bye');
    expect(deps.captured!.soft_warn_fired).toBe(0);
    expect(deps.captured!.model).toBe('gpt-realtime-mini');
  });

  it('all valid terminated_by enum values accepted', async () => {
    const cases = [
      'counterpart_bye',
      'cost_cap_call',
      'cost_cap_daily',
      'cost_cap_monthly',
      'timeout',
    ] as const;
    for (const tb of cases) {
      const deps = makeDeps();
      const handler = makeVoiceFinalizeCallCost(deps);
      const r = (await handler({
        call_id: `c-${tb}`,
        case_type: 'case_6a',
        started_at: '2026-04-19T11:59:00Z',
        ended_at: '2026-04-19T12:01:30Z',
        terminated_by: tb,
      })) as { ok: true };
      expect(r.ok).toBe(true);
      expect(deps.captured!.terminated_by).toBe(tb);
    }
  });

  it('invalid terminated_by → throws BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceFinalizeCallCost(deps);
    await expect(
      handler({
        call_id: 'c1',
        case_type: 'case_6a',
        started_at: '2026-04-19T11:59:00Z',
        ended_at: '2026-04-19T12:01:30Z',
        terminated_by: 'bogus_reason',
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('missing call_id → throws BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceFinalizeCallCost(deps);
    await expect(
      handler({
        case_type: 'case_6a',
        started_at: '2026-04-19T11:59:00Z',
        ended_at: '2026-04-19T12:01:30Z',
        terminated_by: 'counterpart_bye',
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('soft_warn_fired defaults to 0 when omitted; accepts 1 when set', async () => {
    const deps1 = makeDeps();
    const h1 = makeVoiceFinalizeCallCost(deps1);
    await h1({
      call_id: 'c1',
      case_type: 'case_6a',
      started_at: '2026-04-19T11:59:00Z',
      ended_at: '2026-04-19T12:01:30Z',
      terminated_by: 'counterpart_bye',
    });
    expect(deps1.captured!.soft_warn_fired).toBe(0);

    const deps2 = makeDeps();
    const h2 = makeVoiceFinalizeCallCost(deps2);
    await h2({
      call_id: 'c2',
      case_type: 'case_6a',
      started_at: '2026-04-19T11:59:00Z',
      ended_at: '2026-04-19T12:01:30Z',
      terminated_by: 'cost_cap_call',
      soft_warn_fired: 1,
    });
    expect(deps2.captured!.soft_warn_fired).toBe(1);
  });

  it('JSONL: writes call_cost_finalized entry with cost + turn_count + terminated_by', async () => {
    const deps = makeDeps({}, { sum_eur: 0.17, count: 3 });
    const handler = makeVoiceFinalizeCallCost(deps);

    await handler({
      call_id: 'c-jsonl',
      case_type: 'case_6a',
      started_at: '2026-04-19T11:59:00Z',
      ended_at: '2026-04-19T12:01:30Z',
      terminated_by: 'cost_cap_call',
      soft_warn_fired: 1,
    });

    const raw = fs.readFileSync(JSONL_PATH(), 'utf8');
    const entry = JSON.parse(raw.trim().split('\n').pop()!);
    expect(entry.event).toBe('call_cost_finalized');
    expect(entry.tool).toBe('voice.finalize_call_cost');
    expect(entry.call_id).toBe('c-jsonl');
    expect(entry.cost_eur).toBeCloseTo(0.17, 5);
    expect(entry.turn_count).toBe(3);
    expect(entry.terminated_by).toBe('cost_cap_call');
    expect(entry.soft_warn_fired).toBe(1);
    expect(entry).toHaveProperty('latency_ms');
  });

  it('DB throws → handler still returns ok (graceful degrade)', async () => {
    const deps = makeDeps({
      upsertCallCost: () => {
        throw new Error('db locked');
      },
    });
    const handler = makeVoiceFinalizeCallCost(deps);
    const result = (await handler({
      call_id: 'c1',
      case_type: 'case_6a',
      started_at: '2026-04-19T11:59:00Z',
      ended_at: '2026-04-19T12:01:30Z',
      terminated_by: 'timeout',
    })) as { ok: true };
    expect(result.ok).toBe(true);
  });
});
