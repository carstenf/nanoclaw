import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceGetTravelTime,
  VoiceGetTravelTimeDeps,
} from './voice-get-travel-time.js';
import { MapsClientError, TravelTimeResult } from './maps-client.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-maps.jsonl');

function makeSuccessResult(
  overrides: Partial<TravelTimeResult> = {},
): TravelTimeResult {
  return {
    duration_seconds: 2040,
    distance_meters: 38200,
    duration_text: '34 mins',
    distance_text: '38.2 km',
    origin_resolved: 'München Hauptbahnhof',
    destination_resolved: 'Flughafen München',
    mode: 'driving',
    used_traffic: false,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<VoiceGetTravelTimeDeps> = {},
): VoiceGetTravelTimeDeps {
  return {
    getTravelTime: vi.fn().mockResolvedValue(makeSuccessResult()),
    apiKey: 'test-api-key',
    jsonlPath: JSONL_PATH(),
    now: () => 1000,
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('makeVoiceGetTravelTime', () => {
  it('happy path: returns ok:true with travel result', async () => {
    const deps = makeDeps();
    const handler = makeVoiceGetTravelTime(deps);

    const result = await handler({
      call_id: 'test-call-1',
      origin: 'München Hauptbahnhof',
      destination: 'München Flughafen',
      mode: 'driving',
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        duration_seconds: 2040,
        distance_meters: 38200,
        duration_text: '34 mins',
        mode: 'driving',
      },
    });

    // Verify getTravelTime was called with correct args (no extra fields)
    expect(deps.getTravelTime).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'München Hauptbahnhof',
        destination: 'München Flughafen',
        mode: 'driving',
        apiKey: 'test-api-key',
      }),
    );
  });

  it('JSONL travel_time_done written on success — no origin/destination fields', async () => {
    const nowFn = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1042);
    const deps = makeDeps({ now: nowFn });
    const handler = makeVoiceGetTravelTime(deps);

    await handler({
      origin: 'A Straße',
      destination: 'B Straße',
      call_id: 'cid-1',
    });

    const jsonl = fs.readFileSync(JSONL_PATH(), 'utf8').trim().split('\n');
    expect(jsonl).toHaveLength(1);
    const entry = JSON.parse(jsonl[0]);

    expect(entry.event).toBe('travel_time_done');
    expect(entry.tool).toBe('voice.get_travel_time');
    expect(entry.call_id).toBe('cid-1');
    expect(entry.mode).toBe('driving');
    expect(entry.duration_seconds).toBe(2040);
    expect(entry.distance_meters).toBe(38200);
    expect(entry.latency_ms).toBeTypeOf('number');

    // PII-clean: no origin or destination
    expect(entry).not.toHaveProperty('origin');
    expect(entry).not.toHaveProperty('destination');
  });

  it('JSONL travel_time_failed written on MapsClientError', async () => {
    const deps = makeDeps({
      getTravelTime: vi
        .fn()
        .mockRejectedValue(new MapsClientError('zero_results')),
    });
    const handler = makeVoiceGetTravelTime(deps);

    const result = await handler({
      origin: 'Mars',
      destination: 'Jupiter',
    });

    expect(result).toMatchObject({ ok: false, error: 'zero_results' });

    const jsonl = fs.readFileSync(JSONL_PATH(), 'utf8').trim().split('\n');
    const entry = JSON.parse(jsonl[0]);

    expect(entry.event).toBe('travel_time_failed');
    expect(entry.error).toBe('zero_results');
    // PII-clean
    expect(entry).not.toHaveProperty('origin');
    expect(entry).not.toHaveProperty('destination');
  });

  it('BadRequestError on empty origin (zod min-length)', async () => {
    const handler = makeVoiceGetTravelTime(makeDeps());

    await expect(
      handler({ origin: '', destination: 'München Flughafen' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('BadRequestError on missing destination', async () => {
    const handler = makeVoiceGetTravelTime(makeDeps());

    await expect(
      handler({ origin: 'München Hauptbahnhof' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('BadRequestError on invalid mode enum', async () => {
    const handler = makeVoiceGetTravelTime(makeDeps());

    await expect(
      handler({
        origin: 'A',
        destination: 'B',
        mode: 'teleporter',
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('unknown error from client mapped to ok:false error:unknown', async () => {
    const deps = makeDeps({
      getTravelTime: vi
        .fn()
        .mockRejectedValue(new Error('something unexpected')),
    });
    const handler = makeVoiceGetTravelTime(deps);

    const result = await handler({
      origin: 'A',
      destination: 'B',
    });

    expect(result).toMatchObject({ ok: false, error: 'unknown' });
  });

  it('transit mode forwarded correctly to getTravelTime', async () => {
    const deps = makeDeps({
      getTravelTime: vi
        .fn()
        .mockResolvedValue(makeSuccessResult({ mode: 'transit' })),
    });
    const handler = makeVoiceGetTravelTime(deps);

    const result = await handler({
      origin: 'München Hauptbahnhof',
      destination: 'München Flughafen',
      mode: 'transit',
    });

    expect(result).toMatchObject({ ok: true });
    expect(deps.getTravelTime).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'transit' }),
    );
  });
});
