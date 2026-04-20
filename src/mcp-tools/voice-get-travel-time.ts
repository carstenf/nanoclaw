import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  getTravelTime,
  GetTravelTimeOpts,
  TravelTimeResult,
  MapsClientError,
} from './maps-client.js';

export const TravelTimeSchema = z.object({
  call_id: z.string().optional(),
  origin: z.string().min(1).max(300),
  destination: z.string().min(1).max(300),
  mode: z
    .enum(['driving', 'walking', 'bicycling', 'transit'])
    .optional()
    .default('driving'),
  departure_time: z.string().optional(),
});

export interface VoiceGetTravelTimeDeps {
  getTravelTime?: (opts: GetTravelTimeOpts) => Promise<TravelTimeResult>;
  apiKey: string;
  jsonlPath?: string;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Handler factory for voice.get_travel_time MCP tool.
 *
 * Validates input via Zod, calls Maps Distance Matrix, logs JSONL.
 * PII-clean: origin and destination are NOT written to JSONL.
 */
export function makeVoiceGetTravelTime(deps: VoiceGetTravelTimeDeps) {
  const getTravelTimeFn = deps.getTravelTime ?? getTravelTime;
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-maps.jsonl');
  const now = deps.now ?? (() => Date.now());

  return async function voiceGetTravelTime(args: unknown): Promise<unknown> {
    const start = now();

    // Zod parse
    const parseResult = TravelTimeSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }

    const { call_id, origin, destination, mode, departure_time } =
      parseResult.data;

    try {
      const result = await getTravelTimeFn({
        origin,
        destination,
        mode,
        departureTime: departure_time,
        apiKey: deps.apiKey,
        timeoutMs: deps.timeoutMs,
      });

      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'travel_time_done',
        tool: 'voice.get_travel_time',
        call_id: call_id ?? null,
        mode: result.mode,
        duration_seconds: result.duration_seconds,
        distance_meters: result.distance_meters,
        used_traffic: result.used_traffic,
        latency_ms: now() - start,
      });

      return {
        ok: true,
        result: {
          duration_seconds: result.duration_seconds,
          distance_meters: result.distance_meters,
          duration_text: result.duration_text,
          distance_text: result.distance_text,
          origin_resolved: result.origin_resolved,
          destination_resolved: result.destination_resolved,
          mode: result.mode,
          used_traffic: result.used_traffic,
        },
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;

      const errorCode = err instanceof MapsClientError ? err.code : 'unknown';

      logger.warn({
        event: 'voice_get_travel_time_error',
        tool: 'voice.get_travel_time',
        call_id: call_id ?? null,
        error: errorCode,
      });

      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'travel_time_failed',
        tool: 'voice.get_travel_time',
        call_id: call_id ?? null,
        mode: mode ?? 'driving',
        latency_ms: now() - start,
        error: errorCode,
      });

      return { ok: false, error: errorCode };
    }
  };
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}
