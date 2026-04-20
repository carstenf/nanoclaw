import { describe, it, expect, beforeEach } from 'vitest';
import { clearFlatDbCache } from './flat-db-reader.js';
import { makeVoiceGetPracticeProfile } from './voice-get-practice-profile.js';

const PROFILE_A = {
  name: 'Dr. Müller Zahnarzt',
  phone: '+4989123456',
  patient_id: 'PAT-001',
  insurance_type: 'GKV',
  last_visit: '2025-10-15',
  authorized_data_fields: ['name', 'phone', 'insurance_type'],
};

const PROFILE_B = {
  name: 'Example Praxis',
  phone: '+491234567890',
  patient_id: 'PAT-002',
  insurance_type: 'PKV',
  last_visit: '2026-01-20',
  authorized_data_fields: ['name', 'phone'],
};

const FAKE_DB = {
  profiles: {
    'zahnarzt-mueller': PROFILE_A,
    'example-practice': PROFILE_B,
  },
};

function makeHandler(dbOverride?: object) {
  const jsonlLog: object[] = [];
  const readDb =
    dbOverride !== undefined
      ? async (_path: string) => dbOverride
      : async (_path: string) => FAKE_DB;

  const handler = makeVoiceGetPracticeProfile({
    profilesPath: '/fake/practice-profile.json',
    jsonlPath: null as unknown as string,
    readDb,
    appendJsonl: (entry: object) => {
      jsonlLog.push(entry);
    },
  });

  return { handler, jsonlLog };
}

describe('voice_get_practice_profile (REQ-TOOLS-06)', () => {
  beforeEach(() => {
    clearFlatDbCache();
  });

  it('looks up profile by name (case-insensitive), returns REQ-TOOLS-06 fields', async () => {
    const { handler } = makeHandler();
    const result = (await handler({
      call_id: 'test-01',
      name: 'Dr. Müller Zahnarzt',
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.phone).toBe(PROFILE_A.phone);
    expect(inner.patient_id).toBe(PROFILE_A.patient_id);
    expect(inner.insurance_type).toBe(PROFILE_A.insurance_type);
    expect(inner.last_visit).toBe(PROFILE_A.last_visit);
    expect(inner.authorized_data_fields).toEqual(
      PROFILE_A.authorized_data_fields,
    );
  });

  it('case-insensitive name match', async () => {
    const { handler } = makeHandler();
    const result = (await handler({ name: 'example praxis' })) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.phone).toBe(PROFILE_B.phone);
  });

  it('no match → all fields null, authorized_data_fields=[], ok:true', async () => {
    const { handler } = makeHandler();
    const result = (await handler({
      name: 'nonexistent practice',
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.phone).toBeNull();
    expect(inner.patient_id).toBeNull();
    expect(inner.insurance_type).toBeNull();
    expect(inner.last_visit).toBeNull();
    expect(inner.authorized_data_fields).toEqual([]);
  });

  it('empty name → throws BadRequestError', async () => {
    const { BadRequestError } = await import('./voice-on-transcript-turn.js');
    const { handler } = makeHandler();

    await expect(handler({ name: '' })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('missing name → throws BadRequestError', async () => {
    const { BadRequestError } = await import('./voice-on-transcript-turn.js');
    const { handler } = makeHandler();

    await expect(handler({})).rejects.toBeInstanceOf(BadRequestError);
  });

  it('file missing → ok:false error:not_configured', async () => {
    const { FlatDbNotFound } = await import('./flat-db-reader.js');
    const handler = makeVoiceGetPracticeProfile({
      profilesPath: '/fake/practice-profile.json',
      jsonlPath: null as unknown as string,
      readDb: async () => {
        throw new FlatDbNotFound('/fake/practice-profile.json');
      },
      appendJsonl: () => {},
    });

    const result = (await handler({ name: 'anything' })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ ok: false, error: 'not_configured' });
  });

  it('JSONL: practice_profile_lookup_done logged, no profile content', async () => {
    const { handler, jsonlLog } = makeHandler();
    await handler({ name: 'Dr. Müller Zahnarzt' });

    expect(jsonlLog).toHaveLength(1);
    const entry = jsonlLog[0] as Record<string, unknown>;
    expect(entry.event).toBe('practice_profile_lookup_done');
    expect(entry.found).toBe(true);
    expect(entry).not.toHaveProperty('phone');
    expect(entry).not.toHaveProperty('patient_id');
    expect(typeof entry.latency_ms).toBe('number');
  });
});
