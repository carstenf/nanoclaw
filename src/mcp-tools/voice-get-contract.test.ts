import { describe, it, expect, beforeEach } from 'vitest';
import { clearFlatDbCache } from './flat-db-reader.js';
import { makeVoiceGetContract } from './voice-get-contract.js';

const CONTRACT_A = {
  provider: 'Vodafone',
  current_conditions: 'MagentaMobil M, 39.99 EUR/mon',
  expiry_date: '2025-12-31',
  last_review: '2024-01-15',
};

const CONTRACT_B = {
  provider: 'Deutsche Telekom',
  current_conditions: 'MagentaZuhause L, 49.99 EUR/mon',
  expiry_date: '2026-03-31',
  last_review: '2024-06-01',
};

const FAKE_DB = { contracts: [CONTRACT_A, CONTRACT_B] };

function makeHandler(dbOverride?: object) {
  const jsonlLog: object[] = [];
  const readDb =
    dbOverride !== undefined
      ? async (_path: string) => dbOverride
      : async (_path: string) => FAKE_DB;

  const handler = makeVoiceGetContract({
    contractsPath: '/fake/contracts.json',
    jsonlPath: null as unknown as string,
    readDb,
    appendJsonl: (entry: object) => {
      jsonlLog.push(entry);
    },
  });

  return { handler, jsonlLog };
}

describe('voice_get_contract (REQ-TOOLS-04)', () => {
  beforeEach(() => {
    clearFlatDbCache();
  });

  it('looks up contract by provider_name, returns {current_conditions, expiry_date, last_review}', async () => {
    const { handler } = makeHandler();
    const result = (await handler({
      call_id: 'test-01',
      provider_name: 'Vodafone',
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.current_conditions).toBe(CONTRACT_A.current_conditions);
    expect(inner.expiry_date).toBe(CONTRACT_A.expiry_date);
    expect(inner.last_review).toBe(CONTRACT_A.last_review);
  });

  it('case-insensitive provider_name match', async () => {
    const { handler } = makeHandler();
    const result = (await handler({ provider_name: 'telekom' })) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.current_conditions).toBe(CONTRACT_B.current_conditions);
  });

  it('no match → all three fields null, ok:true', async () => {
    const { handler } = makeHandler();
    const result = (await handler({
      provider_name: 'nonexistent provider',
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.current_conditions).toBeNull();
    expect(inner.expiry_date).toBeNull();
    expect(inner.last_review).toBeNull();
  });

  it('empty provider_name → throws BadRequestError', async () => {
    const { BadRequestError } = await import('./voice-on-transcript-turn.js');
    const { handler } = makeHandler();

    await expect(handler({ provider_name: '' })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it('missing provider_name → throws BadRequestError', async () => {
    const { BadRequestError } = await import('./voice-on-transcript-turn.js');
    const { handler } = makeHandler();

    await expect(handler({})).rejects.toBeInstanceOf(BadRequestError);
  });

  it('file missing → ok:false error:not_configured', async () => {
    const { FlatDbNotFound } = await import('./flat-db-reader.js');
    const handler = makeVoiceGetContract({
      contractsPath: '/fake/contracts.json',
      jsonlPath: null as unknown as string,
      readDb: async () => {
        throw new FlatDbNotFound('/fake/contracts.json');
      },
      appendJsonl: () => {},
    });

    const result = (await handler({
      provider_name: 'anything',
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, error: 'not_configured' });
  });

  it('JSONL: contract_lookup_done logged, no contract content', async () => {
    const { handler, jsonlLog } = makeHandler();
    await handler({ provider_name: 'Vodafone' });

    expect(jsonlLog).toHaveLength(1);
    const entry = jsonlLog[0] as Record<string, unknown>;
    expect(entry.event).toBe('contract_lookup_done');
    expect(entry.found).toBe(true);
    expect(entry).not.toHaveProperty('current_conditions');
    expect(typeof entry.latency_ms).toBe('number');
  });
});
