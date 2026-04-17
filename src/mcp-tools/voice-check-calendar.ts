import fs from 'fs';
import path from 'path';

import { z } from 'zod';
import { calendar_v3 } from 'googleapis';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import { getCalendarClient } from './calendar-client.js';

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.GCALENDAR_TIMEOUT_MS ?? '10000',
  10,
);

const CheckCalendarSchema = z.object({
  call_id: z.string().optional(),
  timeMin: z.string(),
  timeMax: z.string(),
  calendarId: z.string().default('primary'),
  maxResults: z.number().int().min(1).max(50).default(20),
});

function validateDates(timeMin: string, timeMax: string): void {
  const min = new Date(timeMin).getTime();
  const max = new Date(timeMax).getTime();
  if (isNaN(min)) throw new BadRequestError('timeMin', 'valid ISO8601 date');
  if (isNaN(max)) throw new BadRequestError('timeMax', 'valid ISO8601 date');
  if (min >= max) throw new BadRequestError('timeMax', 'greater than timeMin');
}

export interface CheckCalendarDeps {
  calendarClient?: () => Promise<calendar_v3.Calendar>;
  jsonlPath?: string;
  now?: () => number;
  timeoutMs?: number;
}

export function makeVoiceCheckCalendar(deps: CheckCalendarDeps = {}) {
  const calendarClientFn =
    deps.calendarClient ?? (() => getCalendarClient());
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-calendar.jsonl');
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function voiceCheckCalendar(args: unknown): Promise<unknown> {
    const start = now();

    // Zod parse
    const parseResult = CheckCalendarSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.errors[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }

    const { call_id, timeMin, timeMax, calendarId, maxResults } =
      parseResult.data;

    // Date validation
    validateDates(timeMin, timeMax);

    let resultCount = 0;
    try {
      const calendar = await calendarClientFn();

      // AbortController for timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let items: calendar_v3.Schema$Event[] = [];
      try {
        const res = await calendar.events.list(
          {
            calendarId,
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults,
          },
          { signal: controller.signal as never },
        );
        items = res.data.items ?? [];
      } catch (err) {
        clearTimeout(timer);
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.includes('aborted'));
        if (isAbort) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_check_done',
            call_id: call_id ?? null,
            tool: 'voice.check_calendar',
            latency_ms: now() - start,
            result_count: 0,
            calendar_id: calendarId,
            error: 'gcal_timeout',
          });
          return { ok: false, error: 'gcal_timeout' };
        }
        throw err;
      }
      clearTimeout(timer);

      resultCount = items.length;

      const busy = items.map((e) => ({
        eventId: e.id ?? null,
        start: e.start?.dateTime ?? e.start?.date ?? null,
        end: e.end?.dateTime ?? e.end?.date ?? null,
        summary: e.summary ?? null,
      }));

      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_check_done',
        call_id: call_id ?? null,
        tool: 'voice.check_calendar',
        latency_ms: now() - start,
        result_count: resultCount,
        calendar_id: calendarId,
      });

      return { ok: true, result: { busy } };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.warn({ event: 'voice_check_calendar_error', err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_check_done',
        call_id: call_id ?? null,
        tool: 'voice.check_calendar',
        latency_ms: now() - start,
        result_count: 0,
        calendar_id: calendarId,
        error: 'internal',
      });
      return { ok: false, error: 'internal' };
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
