// Phase 4 (INFRA-06): voice.record_turn_cost MCP handler — unit tests.
// RED during Wave-0: handler does not exist yet; Task 4 turns this GREEN.
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceRecordTurnCost,
  VoiceRecordTurnCostDeps,
} from './voice-record-turn-cost.js';
import type { VoiceTurnCostRow } from '../cost-ledger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrecordturn-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-cost.jsonl');
const BASE_NOW = new Date('2026-04-19T12:00:00Z').getTime();

function makeDeps(
  overrides: Partial<VoiceRecordTurnCostDeps> = {},
): VoiceRecordTurnCostDeps & { captured: VoiceTurnCostRow | null } {
  const deps: VoiceRecordTurnCostDeps & { captured: VoiceTurnCostRow | null } =
    {
      captured: null,
      insertTurnCost: (row) => {
        deps.captured = row;
      },
      jsonlPath: JSONL_PATH(),
      now: () => BASE_NOW,
      ...overrides,
    };
  return deps;
}

describe('makeVoiceRecordTurnCost (INFRA-06)', () => {
  it('happy path: calls insertTurnCost with full row and returns {ok, recorded:true}', async () => {
    const deps = makeDeps();
    const handler = makeVoiceRecordTurnCost(deps);

    const result = (await handler({
      call_id: 'c1',
      turn_id: 't1',
      audio_in_tokens: 1000,
      audio_out_tokens: 500,
      cached_in_tokens: 200,
      text_in_tokens: 10,
      text_out_tokens: 5,
      cost_eur: 0.012,
    })) as { ok: true; result: { recorded: boolean } };

    expect(result.ok).toBe(true);
    expect(result.result.recorded).toBe(true);

    expect(deps.captured).not.toBeNull();
    expect(deps.captured!.call_id).toBe('c1');
    expect(deps.captured!.turn_id).toBe('t1');
    expect(deps.captured!.audio_in_tokens).toBe(1000);
    expect(deps.captured!.cached_in_tokens).toBe(200);
    expect(deps.captured!.cost_eur).toBeCloseTo(0.012, 5);
    expect(deps.captured!.ts).toBeTruthy();
  });

  it('missing call_id → throws BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceRecordTurnCost(deps);

    await expect(
      handler({
        turn_id: 't1',
        cost_eur: 0.1,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('negative cost_eur → throws BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceRecordTurnCost(deps);

    await expect(
      handler({
        call_id: 'c1',
        turn_id: 't1',
        cost_eur: -0.5,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('defaults token fields to 0 when omitted', async () => {
    const deps = makeDeps();
    const handler = makeVoiceRecordTurnCost(deps);

    await handler({
      call_id: 'c1',
      turn_id: 't1',
      cost_eur: 0.01,
    });

    expect(deps.captured).not.toBeNull();
    expect(deps.captured!.audio_in_tokens).toBe(0);
    expect(deps.captured!.audio_out_tokens).toBe(0);
    expect(deps.captured!.cached_in_tokens).toBe(0);
    expect(deps.captured!.text_in_tokens).toBe(0);
    expect(deps.captured!.text_out_tokens).toBe(0);
  });

  it('JSONL: writes turn_cost_recorded entry with call_id + turn_id + cost_eur', async () => {
    const deps = makeDeps();
    const handler = makeVoiceRecordTurnCost(deps);

    await handler({
      call_id: 'c-jsonl',
      turn_id: 't-jsonl',
      cost_eur: 0.05,
    });

    const raw = fs.readFileSync(JSONL_PATH(), 'utf8');
    const entry = JSON.parse(raw.trim().split('\n').pop()!);
    expect(entry.event).toBe('turn_cost_recorded');
    expect(entry.tool).toBe('voice.record_turn_cost');
    expect(entry.call_id).toBe('c-jsonl');
    expect(entry.turn_id).toBe('t-jsonl');
    expect(entry.cost_eur).toBeCloseTo(0.05, 5);
    expect(entry).toHaveProperty('latency_ms');
  });

  it('DB throws → handler still returns ok, logs warn (graceful degrade)', async () => {
    const deps = makeDeps({
      insertTurnCost: () => {
        throw new Error('db locked');
      },
    });
    const handler = makeVoiceRecordTurnCost(deps);

    const result = (await handler({
      call_id: 'c1',
      turn_id: 't1',
      cost_eur: 0.01,
    })) as { ok: true; result: { recorded: boolean } };
    // handler does not throw on DB error; JSONL is audit trail of last resort
    expect(result.ok).toBe(true);
  });
});
