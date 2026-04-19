// src/recon-3way.test.ts
// Phase 4 Plan 04-04 (Success-Criterion 5): 3-way recon — calendar ↔ readback ↔ Discord.
// RED during Wave-4: the module does not exist yet. Task 3 turns it GREEN.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createSchema } from './cost-ledger.js';
import { runRecon3Way } from './recon-3way.js';

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon3way-test-'));
  db = new Database(':memory:');
  createSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_NOW = new Date('2026-04-19T12:00:00Z').getTime();
const SIX_HOURS_AGO = new Date(BASE_NOW - 6 * 60 * 60 * 1000).toISOString();

function seedCall(callId: string, startedAt: string, terminatedBy: string | null = 'counterpart_bye'): void {
  db.prepare(
    `INSERT INTO voice_call_costs (call_id, case_type, started_at, ended_at, cost_eur, turn_count, terminated_by, soft_warn_fired, model)
     VALUES (?, 'unknown', ?, ?, 0.10, 3, ?, 0, 'gpt-realtime-mini')`,
  ).run(callId, startedAt, startedAt, terminatedBy);
}

function writeTurns(callId: string, entries: Array<Record<string, unknown>>): void {
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(tmpDir, `turns-${callId}.jsonl`), body);
}

describe('runRecon3Way', () => {
  it('no drift when all 3 sources agree on every call', async () => {
    seedCall('call-A', SIX_HOURS_AGO);
    seedCall('call-B', SIX_HOURS_AGO);
    writeTurns('call-A', [{ event: 'tool_dispatch_ok', call_id: 'call-A', turn_id: 't1' }]);
    writeTurns('call-B', [{ event: 'tool_dispatch_ok', call_id: 'call-B', turn_id: 't1' }]);

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const openPointSpy = vi.fn();

    const result = await runRecon3Way({
      db,
      baseDir: tmpDir,
      listDiscordSummaryMessages: async () => [
        { call_id: 'call-A' },
        { call_id: 'call-B' },
      ],
      sendDiscordAlert: alertSpy,
      writeStateRepoOpenPoint: openPointSpy,
      now: () => BASE_NOW,
    });

    expect(result.checked).toBe(2);
    expect(result.drift).toBe(0);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(openPointSpy).not.toHaveBeenCalled();
  });

  it('alerts on 2-of-3 drift: calendar + discord agree, JSONL missing readback signal', async () => {
    seedCall('call-X', SIX_HOURS_AGO);
    // No turns-call-X.jsonl written — readback source is empty

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const openPointSpy = vi.fn();

    const result = await runRecon3Way({
      db,
      baseDir: tmpDir,
      listDiscordSummaryMessages: async () => [{ call_id: 'call-X' }],
      sendDiscordAlert: alertSpy,
      writeStateRepoOpenPoint: openPointSpy,
      now: () => BASE_NOW,
    });

    expect(result.checked).toBe(1);
    expect(result.drift).toBe(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(openPointSpy).toHaveBeenCalledTimes(1);
    const msg = alertSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/call-X/);
  });

  it('excludes calls terminated by cost_cap_call (Pitfall 2 defense)', async () => {
    seedCall('call-capped', SIX_HOURS_AGO, 'cost_cap_call');

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const openPointSpy = vi.fn();

    const result = await runRecon3Way({
      db,
      baseDir: tmpDir,
      listDiscordSummaryMessages: async () => [],
      sendDiscordAlert: alertSpy,
      writeStateRepoOpenPoint: openPointSpy,
      now: () => BASE_NOW,
    });

    expect(result.checked).toBe(0);
    expect(result.drift).toBe(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('tolerates readback event-name variants (Pitfall 9 — tolerant match)', async () => {
    seedCall('call-V1', SIX_HOURS_AGO);
    seedCall('call-V2', SIX_HOURS_AGO);
    seedCall('call-V3', SIX_HOURS_AGO);

    // Multiple candidate event names all indicate readback passed.
    writeTurns('call-V1', [{ event: 'readback_confirmed', call_id: 'call-V1' }]);
    writeTurns('call-V2', [{ event: 'tool_dispatch_ok', call_id: 'call-V2' }]);
    writeTurns('call-V3', [{ event: 'readback_ok', call_id: 'call-V3' }]);

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const result = await runRecon3Way({
      db,
      baseDir: tmpDir,
      listDiscordSummaryMessages: async () => [
        { call_id: 'call-V1' },
        { call_id: 'call-V2' },
        { call_id: 'call-V3' },
      ],
      sendDiscordAlert: alertSpy,
      writeStateRepoOpenPoint: vi.fn(),
      now: () => BASE_NOW,
    });

    expect(result.checked).toBe(3);
    expect(result.drift).toBe(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
