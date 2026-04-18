import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { clearFlatDbCache } from './flat-db-reader.js';
import { makeVoiceGetContract } from './voice-get-contract.js';

const CONTRACT_A = {
  id: 'vodafone-mobile-2024',
  provider: 'Vodafone',
  product: 'MagentaMobil M',
  monthly_cost_eur: 39.99,
  notes: 'Läuft bis Ende 2025',
};

const CONTRACT_B = {
  id: 'telekom-dsl-2023',
  provider: 'Deutsche Telekom',
  product: 'MagentaZuhause L',
  monthly_cost_eur: 49.99,
};

const FAKE_DB = { contracts: [CONTRACT_A, CONTRACT_B] };

function makeHandler(dbOverride?: object) {
  const jsonlLog: object[] = [];
  const readDb = dbOverride !== undefined
    ? async (_path: string) => dbOverride
    : async (_path: string) => FAKE_DB;

  const handler = makeVoiceGetContract({
    contractsPath: '/fake/contracts.json',
    jsonlPath: null as unknown as string, // suppress file writes
    readDb,
    appendJsonl: (entry: object) => { jsonlLog.push(entry); },
  });

  return { handler, jsonlLog };
}

describe('voice.get_contract', () => {
  beforeEach(() => {
    clearFlatDbCache();
  });

  it('looks up contract by exact id', async () => {
    const { handler } = makeHandler();
    const result = await handler({ call_id: 'test-01', id: 'vodafone-mobile-2024' }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.contract).toMatchObject({ id: 'vodafone-mobile-2024', provider: 'Vodafone' });
  });

  it('looks up contract by provider substring (case-insensitive)', async () => {
    const { handler } = makeHandler();
    const result = await handler({ provider: 'telekom' }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.contract).toMatchObject({ id: 'telekom-dsl-2023' });
  });

  it('returns contract:null when no match found', async () => {
    const { handler } = makeHandler();
    const result = await handler({ id: 'no-such-contract' }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.contract).toBeNull();
  });

  it('returns ok:false error:not_configured when file does not exist', async () => {
    const { FlatDbNotFound } = await import('./flat-db-reader.js');
    const handler = makeVoiceGetContract({
      contractsPath: '/fake/contracts.json',
      jsonlPath: null as unknown as string,
      readDb: async () => { throw new FlatDbNotFound('/fake/contracts.json'); },
      appendJsonl: () => {},
    });

    const result = await handler({ id: 'x' }) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, error: 'not_configured' });
  });

  it('throws BadRequestError when both id and provider are absent', async () => {
    const { BadRequestError } = await import('./voice-on-transcript-turn.js');
    const { handler } = makeHandler();

    await expect(handler({})).rejects.toBeInstanceOf(BadRequestError);
  });

  it('logs contract_lookup_done event to JSONL (no contract content)', async () => {
    const { handler, jsonlLog } = makeHandler();
    await handler({ id: 'vodafone-mobile-2024' });

    expect(jsonlLog).toHaveLength(1);
    const entry = jsonlLog[0] as Record<string, unknown>;
    expect(entry.event).toBe('contract_lookup_done');
    expect(entry.found).toBe(true);
    expect(entry).not.toHaveProperty('contract');
    expect(entry).not.toHaveProperty('monthly_cost_eur');
    expect(typeof entry.latency_ms).toBe('number');
  });
});
