import { describe, it, expect, beforeEach } from 'vitest';
import { clearFlatDbCache } from './flat-db-reader.js';
import { makeVoiceGetPracticeProfile } from './voice-get-practice-profile.js';

const PROFILE_A = {
  name: 'Dr. Müller Zahnarzt',
  type: 'doctor',
  address: 'Hauptstr. 1, 80333 München',
  phone: '+4989123456',
};

const PROFILE_B = {
  name: 'Ristorante Roma',
  type: 'restaurant',
  address: 'Marienplatz 5, 80331 München',
};

const FAKE_DB = {
  profiles: {
    'zahnarzt-mueller': PROFILE_A,
    'ristorante-roma': PROFILE_B,
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

describe('voice.get_practice_profile', () => {
  beforeEach(() => {
    clearFlatDbCache();
  });

  it('lists all profile keys when key is absent', async () => {
    const { handler } = makeHandler();
    const result = (await handler({ call_id: 'test-01' })) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(Array.isArray(inner.keys)).toBe(true);
    expect(inner.keys).toContain('zahnarzt-mueller');
    expect(inner.keys).toContain('ristorante-roma');
  });

  it('looks up profile by exact key', async () => {
    const { handler } = makeHandler();
    const result = (await handler({ key: 'zahnarzt-mueller' })) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.profile).toMatchObject({ name: 'Dr. Müller Zahnarzt', type: 'doctor' });
  });

  it('returns profile:null when key does not match', async () => {
    const { handler } = makeHandler();
    const result = (await handler({ key: 'no-such-practice' })) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.profile).toBeNull();
  });

  it('returns ok:false error:not_configured when file does not exist', async () => {
    const { FlatDbNotFound } = await import('./flat-db-reader.js');
    const handler = makeVoiceGetPracticeProfile({
      profilesPath: '/fake/practice-profile.json',
      jsonlPath: null as unknown as string,
      readDb: async () => { throw new FlatDbNotFound('/fake/practice-profile.json'); },
      appendJsonl: () => {},
    });

    const result = (await handler({})) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, error: 'not_configured' });
  });

  it('returns empty keys array when profiles obj is missing in file', async () => {
    const { handler } = makeHandler({});  // DB has no profiles key

    const result = (await handler({})) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true });
    const inner = result.result as Record<string, unknown>;
    expect(inner.keys).toEqual([]);
  });

  it('logs practice_profile_lookup_done event to JSONL (no profile content)', async () => {
    const { handler, jsonlLog } = makeHandler();
    await handler({ key: 'zahnarzt-mueller' });

    expect(jsonlLog).toHaveLength(1);
    const entry = jsonlLog[0] as Record<string, unknown>;
    expect(entry.event).toBe('practice_profile_lookup_done');
    expect(entry.found).toBe(true);
    expect(entry).not.toHaveProperty('profile');
    expect(entry).not.toHaveProperty('address');
    expect(typeof entry.latency_ms).toBe('number');
  });
});
