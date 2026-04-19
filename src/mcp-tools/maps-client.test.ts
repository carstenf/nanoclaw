import { describe, it, expect, vi } from 'vitest';

import { getTravelTime, MapsClientError } from './maps-client.js';

// Helper: build a minimal Distance Matrix API success response
function makeSuccessResponse(
  overrides: {
    topStatus?: string;
    elementStatus?: string;
    duration?: number;
    durationText?: string;
    distance?: number;
    distanceText?: string;
    durationInTraffic?: number;
    originAddr?: string;
    destAddr?: string;
  } = {},
) {
  const elementStatus = overrides.elementStatus ?? 'OK';
  const element: Record<string, unknown> = {
    status: elementStatus,
  };
  if (elementStatus === 'OK') {
    element.duration = {
      value: overrides.duration ?? 2040,
      text: overrides.durationText ?? '34 mins',
    };
    element.distance = {
      value: overrides.distance ?? 38200,
      text: overrides.distanceText ?? '38.2 km',
    };
    if (overrides.durationInTraffic !== undefined) {
      element.duration_in_traffic = {
        value: overrides.durationInTraffic,
        text: `${Math.round(overrides.durationInTraffic / 60)} mins`,
      };
    }
  }

  return {
    status: overrides.topStatus ?? 'OK',
    origin_addresses: [
      overrides.originAddr ?? 'München Hauptbahnhof, Bayern, Deutschland',
    ],
    destination_addresses: [
      overrides.destAddr ?? 'Flughafen München, Nordallee 25, 85356 München',
    ],
    rows: [{ elements: [element] }],
  };
}

function makeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('getTravelTime', () => {
  it('happy path: returns duration_seconds and distance_meters from mock response', async () => {
    const mockFetch = makeFetch(makeSuccessResponse());

    const result = await getTravelTime({
      origin: 'München Hauptbahnhof',
      destination: 'München Flughafen',
      mode: 'driving',
      apiKey: 'test-key',
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(result.duration_seconds).toBe(2040);
    expect(result.distance_meters).toBe(38200);
    expect(result.duration_text).toBe('34 mins');
    expect(result.distance_text).toBe('38.2 km');
    expect(result.mode).toBe('driving');
    expect(result.used_traffic).toBe(false);
    expect(result.origin_resolved).toContain('München Hauptbahnhof');
    expect(result.destination_resolved).toContain('Flughafen');

    // Verify URL contains distancematrix endpoint
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('distancematrix');
    expect(calledUrl).toContain('origins=');
    expect(calledUrl).toContain('destinations=');
    expect(calledUrl).toContain('key=test-key');
  });

  it('uses duration_in_traffic when available for driving mode', async () => {
    const mockFetch = makeFetch(
      makeSuccessResponse({ duration: 2040, durationInTraffic: 2700 }),
    );

    const result = await getTravelTime({
      origin: 'München Hauptbahnhof',
      destination: 'München Flughafen',
      mode: 'driving',
      departureTime: 'now',
      apiKey: 'test-key',
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(result.duration_seconds).toBe(2700);
    expect(result.used_traffic).toBe(true);
  });

  it('OVER_QUERY_LIMIT: throws MapsClientError with code over_query_limit', async () => {
    const mockFetch = makeFetch(
      makeSuccessResponse({ topStatus: 'OVER_QUERY_LIMIT' }),
    );

    await expect(
      getTravelTime({
        origin: 'A',
        destination: 'B',
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof MapsClientError && e.code === 'over_query_limit',
    );
  });

  it('ZERO_RESULTS at element level: throws MapsClientError with code zero_results', async () => {
    const mockFetch = makeFetch(
      makeSuccessResponse({ elementStatus: 'ZERO_RESULTS' }),
    );

    await expect(
      getTravelTime({
        origin: 'Mars',
        destination: 'Jupiter',
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof MapsClientError && e.code === 'zero_results',
    );
  });

  it('timeout: throws MapsClientError with code timeout when AbortError fires', async () => {
    const abortError = new DOMException(
      'The operation was aborted',
      'AbortError',
    );
    const mockFetch = vi.fn().mockRejectedValue(abortError);

    await expect(
      getTravelTime({
        origin: 'A',
        destination: 'B',
        apiKey: 'test-key',
        timeoutMs: 1,
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof MapsClientError && e.code === 'timeout',
    );
  });

  it('missing key: throws MapsClientError with code missing_key when apiKey is empty', async () => {
    await expect(
      getTravelTime({
        origin: 'A',
        destination: 'B',
        apiKey: '',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof MapsClientError && e.code === 'missing_key',
    );
  });

  it('network error: throws MapsClientError with code network on fetch rejection', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      getTravelTime({
        origin: 'A',
        destination: 'B',
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof MapsClientError && e.code === 'network',
    );
  });

  it('REQUEST_DENIED: throws MapsClientError with code request_denied', async () => {
    const mockFetch = makeFetch(
      makeSuccessResponse({ topStatus: 'REQUEST_DENIED' }),
    );

    await expect(
      getTravelTime({
        origin: 'A',
        destination: 'B',
        apiKey: 'bad-key',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof MapsClientError && e.code === 'request_denied',
    );
  });
});
