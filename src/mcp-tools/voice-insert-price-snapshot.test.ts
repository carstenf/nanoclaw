// Phase 4 Plan 04-04 (INFRA-07): voice.insert_price_snapshot MCP handler — unit tests.
// RED gate: the handler module does not exist yet. Task 2 turns this GREEN.
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceInsertPriceSnapshot,
  VoiceInsertPriceSnapshotDeps,
} from './voice-insert-price-snapshot.js';
import type { VoicePriceSnapshotRow } from '../cost-ledger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinsertprice-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-cost.jsonl');
const BASE_NOW = new Date('2026-04-19T02:00:00Z').getTime();

const VALID_ARGS = {
  ts: '2026-04-19T02:00:00Z',
  model: 'gpt-realtime-mini',
  audio_in_usd: 10.0,
  audio_out_usd: 20.0,
  audio_cached_usd: 0.3,
  text_in_usd: 0.6,
  text_out_usd: 2.4,
  usd_to_eur: 0.93,
  source: 'hetzner_scrape',
};

function makeDeps(
  overrides: Partial<VoiceInsertPriceSnapshotDeps> = {},
): VoiceInsertPriceSnapshotDeps & { captured: VoicePriceSnapshotRow | null } {
  const deps: VoiceInsertPriceSnapshotDeps & {
    captured: VoicePriceSnapshotRow | null;
  } = {
    captured: null,
    insertPriceSnapshot: (row) => {
      deps.captured = row;
    },
    jsonlPath: JSONL_PATH(),
    now: () => BASE_NOW,
    ...overrides,
  };
  return deps;
}

describe('makeVoiceInsertPriceSnapshot (INFRA-07)', () => {
  it('happy path: inserts a well-formed snapshot row and returns ok:true', async () => {
    const deps = makeDeps();
    const handler = makeVoiceInsertPriceSnapshot(deps);

    const result = (await handler(VALID_ARGS)) as {
      ok: true;
      result: { inserted: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.result.inserted).toBe(true);
    expect(deps.captured).not.toBeNull();
    expect(deps.captured?.ts).toBe(VALID_ARGS.ts);
    expect(deps.captured?.model).toBe(VALID_ARGS.model);
    expect(deps.captured?.audio_in_usd).toBeCloseTo(10.0);
    expect(deps.captured?.source).toBe('hetzner_scrape');
  });

  it('emits a JSONL audit row with event=price_snapshot_inserted', async () => {
    const deps = makeDeps();
    const handler = makeVoiceInsertPriceSnapshot(deps);

    await handler(VALID_ARGS);

    const raw = fs.readFileSync(JSONL_PATH(), 'utf8').trim();
    const entry = JSON.parse(raw);
    expect(entry.event).toBe('price_snapshot_inserted');
    expect(entry.tool).toBe('voice.insert_price_snapshot');
    expect(entry.model).toBe('gpt-realtime-mini');
    expect(entry.source).toBe('hetzner_scrape');
    expect(typeof entry.latency_ms).toBe('number');
  });

  it('throws BadRequestError when model is missing', async () => {
    const deps = makeDeps();
    const handler = makeVoiceInsertPriceSnapshot(deps);

    await expect(
      handler({ ...VALID_ARGS, model: undefined }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws BadRequestError when audio_in_usd is negative', async () => {
    const deps = makeDeps();
    const handler = makeVoiceInsertPriceSnapshot(deps);

    await expect(
      handler({ ...VALID_ARGS, audio_in_usd: -5 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws BadRequestError when usd_to_eur is zero', async () => {
    const deps = makeDeps();
    const handler = makeVoiceInsertPriceSnapshot(deps);

    await expect(
      handler({ ...VALID_ARGS, usd_to_eur: 0 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws BadRequestError when source is empty', async () => {
    const deps = makeDeps();
    const handler = makeVoiceInsertPriceSnapshot(deps);

    await expect(handler({ ...VALID_ARGS, source: '' })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it('graceful-degrades on DB error — returns ok:true and logs JSONL', async () => {
    const deps = makeDeps({
      insertPriceSnapshot: () => {
        throw new Error('SQLITE_BUSY');
      },
    });
    const handler = makeVoiceInsertPriceSnapshot(deps);

    const result = (await handler(VALID_ARGS)) as { ok: boolean };
    // Match the voice-record-turn-cost contract: DB fail still returns
    // ok:true so the Hetzner scraper's POST doesn't retry-storm. JSONL
    // is the audit trail of last resort.
    expect(result.ok).toBe(true);

    const raw = fs.readFileSync(JSONL_PATH(), 'utf8').trim();
    const entry = JSON.parse(raw);
    expect(entry.event).toBe('price_snapshot_inserted');
  });
});
