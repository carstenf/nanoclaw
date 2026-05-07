// src/openai-cost-client.test.ts
// Phase B: month-to-date USD aggregation + 5-min cache.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the env reader BEFORE importing the SUT — production resolves the
// admin key from .env when not passed via DI, and the dev box's .env
// would leak into the "missing key" test below.
vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}));

import {
  getMonthToDateUsd,
  _resetCostCache,
  type OrgCostsResponse,
} from './openai-cost-client.js';

function fakeBucket(usd: number): OrgCostsResponse['data'][number] {
  return {
    results: [{ amount: { value: String(usd), currency: 'usd' } }],
  };
}

function fakeFetch(
  responses: Array<Partial<OrgCostsResponse>>,
): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const body = responses[i++] ?? { data: [], has_more: false };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('openai-cost-client — getMonthToDateUsd', () => {
  beforeEach(() => {
    _resetCostCache();
  });

  it('sums all results across all buckets in a single page', async () => {
    const fetchFn = fakeFetch([
      {
        data: [fakeBucket(0.12), fakeBucket(0.34), fakeBucket(0.56)],
        has_more: false,
      },
    ]);
    const cost = await getMonthToDateUsd({
      fetchFn,
      adminKey: 'sk-admin-test',
      now: () => new Date('2026-05-07T10:00:00Z'),
    });
    expect(cost.usd).toBeCloseTo(0.12 + 0.34 + 0.56, 6);
    expect(cost.cache_age_s).toBe(0);
    expect(cost.window_start).toBe('2026-05-01T00:00:00.000Z');
  });

  it('walks pagination via has_more + next_page', async () => {
    const fetchFn = fakeFetch([
      { data: [fakeBucket(1.0)], has_more: true, next_page: 'p2' },
      { data: [fakeBucket(2.0)], has_more: true, next_page: 'p3' },
      { data: [fakeBucket(3.0)], has_more: false },
    ]);
    const cost = await getMonthToDateUsd({
      fetchFn,
      adminKey: 'sk-admin-test',
      now: () => new Date('2026-05-07T10:00:00Z'),
    });
    expect(cost.usd).toBeCloseTo(6.0, 6);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('caches results for 5 minutes — second call within TTL skips fetch', async () => {
    const fetchFn = fakeFetch([
      { data: [fakeBucket(5.0)], has_more: false },
    ]);
    const t0 = new Date('2026-05-07T10:00:00Z');
    const t1 = new Date('2026-05-07T10:04:00Z'); // +4 min, still cached
    await getMonthToDateUsd({
      fetchFn,
      adminKey: 'sk-admin-test',
      now: () => t0,
    });
    const cost2 = await getMonthToDateUsd({
      fetchFn,
      adminKey: 'sk-admin-test',
      now: () => t1,
    });
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(cost2.usd).toBe(5.0);
    expect(cost2.cache_age_s).toBe(240); // 4 min
  });

  it('refetches after cache TTL expires', async () => {
    const fetchFn = fakeFetch([
      { data: [fakeBucket(5.0)], has_more: false },
      { data: [fakeBucket(7.0)], has_more: false },
    ]);
    const t0 = new Date('2026-05-07T10:00:00Z');
    const t1 = new Date('2026-05-07T10:06:00Z'); // +6 min, expired
    await getMonthToDateUsd({
      fetchFn,
      adminKey: 'sk-admin-test',
      now: () => t0,
    });
    const cost2 = await getMonthToDateUsd({
      fetchFn,
      adminKey: 'sk-admin-test',
      now: () => t1,
    });
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(cost2.usd).toBe(7.0);
  });

  it('noCache=true bypasses cache', async () => {
    const fetchFn = fakeFetch([
      { data: [fakeBucket(5.0)], has_more: false },
      { data: [fakeBucket(8.0)], has_more: false },
    ]);
    const now = () => new Date('2026-05-07T10:00:00Z');
    await getMonthToDateUsd({ fetchFn, adminKey: 'k', now });
    const c2 = await getMonthToDateUsd({
      fetchFn,
      adminKey: 'k',
      now,
      noCache: true,
    });
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(c2.usd).toBe(8.0);
  });

  it('throws when admin key missing AND env empty', async () => {
    delete process.env.OPENAI_ADMIN_KEY;
    await expect(
      getMonthToDateUsd({
        fetchFn: vi.fn() as unknown as typeof fetch,
        now: () => new Date(),
        adminKey: undefined,
      }),
    ).rejects.toThrow(/OPENAI_ADMIN_KEY not set/);
  });

  it('throws on non-2xx with truncated body', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('forbidden: scope missing', { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(
      getMonthToDateUsd({
        fetchFn,
        adminKey: 'sk-admin-test',
        now: () => new Date(),
      }),
    ).rejects.toThrow(/openai admin costs 403:/);
  });

  it('skips malformed numeric values silently', async () => {
    const fetchFn = fakeFetch([
      {
        data: [
          {
            results: [
              { amount: { value: 'NaN', currency: 'usd' } },
              { amount: { value: '1.50', currency: 'usd' } },
              { amount: { value: 'oops', currency: 'usd' } },
            ],
          },
        ],
        has_more: false,
      },
    ]);
    const cost = await getMonthToDateUsd({
      fetchFn,
      adminKey: 'sk-admin-test',
      now: () => new Date('2026-05-07T10:00:00Z'),
    });
    expect(cost.usd).toBeCloseTo(1.5, 6);
  });
});
