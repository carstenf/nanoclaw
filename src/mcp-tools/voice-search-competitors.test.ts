import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  makeVoiceSearchCompetitors,
  type VoiceSearchCompetitorsDeps,
} from './voice-search-competitors.js';

describe('voice.search_competitors (TOOLS-05)', () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscomp-test-'));
    jsonlPath = path.join(tmpDir, 'voice-lookup.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(
    overrides: Partial<VoiceSearchCompetitorsDeps> = {},
  ): VoiceSearchCompetitorsDeps {
    return {
      provider: undefined,
      jsonlPath,
      now: () => 1_000_000,
      ...overrides,
    };
  }

  it('returns {ok:false, error:not_configured} when provider absent (Phase-4 gate)', async () => {
    const handler = makeVoiceSearchCompetitors(makeDeps({ provider: undefined }));
    const res = await handler({
      category: 'physiotherapy',
      criteria: { zip: '80339' },
    });
    expect(res).toEqual({ ok: false, error: 'not_configured' });
  });

  it("returns {ok:false, error:not_configured} when provider='not_configured' literal", async () => {
    const handler = makeVoiceSearchCompetitors(
      makeDeps({ provider: 'not_configured' }),
    );
    const res = await handler({
      category: 'insurance',
      criteria: { max_price_eur: 50 },
    });
    expect(res).toEqual({ ok: false, error: 'not_configured' });
  });

  it('returns {ok:false, error:not_configured} when provider set but no backend wired', async () => {
    const handler = makeVoiceSearchCompetitors(
      makeDeps({ provider: 'claude_web' }),
    );
    const res = await handler({
      category: 'insurance',
      criteria: { max_price_eur: 50 },
    });
    expect(res).toEqual({ ok: false, error: 'not_configured' });
  });

  it('returns offers when backend provides them (happy path)', async () => {
    const backend = async (category: string, _criteria: unknown) => {
      expect(category).toBe('insurance');
      return {
        offers: [
          {
            provider: 'Verivox',
            price: '29 EUR',
            terms: '12 mo',
            source_url: 'https://example.com/1',
          },
        ],
      };
    };
    const handler = makeVoiceSearchCompetitors(
      makeDeps({ provider: 'claude_web', askCompetitorsBackend: backend }),
    );
    const res = (await handler({
      category: 'insurance',
      criteria: { max_price_eur: 50 },
    })) as { ok: true; result: { offers: Array<{ provider: string }> } };
    expect(res.ok).toBe(true);
    expect(res.result.offers).toHaveLength(1);
    expect(res.result.offers[0].provider).toBe('Verivox');
  });

  it('throws BadRequestError on missing category', async () => {
    const handler = makeVoiceSearchCompetitors(
      makeDeps({ provider: 'claude_web' }),
    );
    await expect(
      handler({ criteria: { x: 1 } }),
    ).rejects.toMatchObject({ name: 'BadRequestError' });
  });

  it('throws BadRequestError on non-object criteria', async () => {
    const handler = makeVoiceSearchCompetitors(
      makeDeps({ provider: 'claude_web' }),
    );
    await expect(
      handler({ category: 'x', criteria: 'not-an-object' }),
    ).rejects.toMatchObject({ name: 'BadRequestError' });
  });

  it('returns {ok:false, error:backend_error} when backend throws', async () => {
    const backend = async () => {
      throw new Error('network down');
    };
    const handler = makeVoiceSearchCompetitors(
      makeDeps({ provider: 'claude_web', askCompetitorsBackend: backend }),
    );
    const res = await handler({
      category: 'insurance',
      criteria: { max_price_eur: 50 },
    });
    expect(res).toEqual({ ok: false, error: 'backend_error' });
  });

  it('appends JSONL audit row on happy path with offer_count + latency', async () => {
    let calls = 0;
    const backend = async () => ({
      offers: [
        {
          provider: 'X',
          price: '1 EUR',
          terms: '1 mo',
          source_url: 'https://example.com',
        },
      ],
    });
    const handler = makeVoiceSearchCompetitors(
      makeDeps({
        provider: 'claude_web',
        askCompetitorsBackend: backend,
        now: () => {
          calls++;
          return calls === 1 ? 1000 : 1250; // start=1000, end=1250 → latency_ms=250
        },
      }),
    );
    await handler({
      category: 'insurance',
      criteria: { max_price_eur: 50 },
    });
    const lines = fs
      .readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('search_competitors_done');
    expect(lines[0].offer_count).toBe(1);
    expect(lines[0].provider).toBe('claude_web');
    expect(lines[0].latency_ms).toBe(250);
  });

  it('appends JSONL audit row on not_configured path', async () => {
    const handler = makeVoiceSearchCompetitors(
      makeDeps({ provider: undefined }),
    );
    await handler({
      category: 'insurance',
      criteria: { max_price_eur: 50 },
      call_id: 'rtc_abc',
    });
    const lines = fs
      .readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('search_competitors_not_configured');
    expect(lines[0].call_id).toBe('rtc_abc');
  });
});
