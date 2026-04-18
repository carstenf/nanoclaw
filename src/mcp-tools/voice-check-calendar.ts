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
const TIMEZONE = process.env.TZ ?? 'Europe/Berlin';

// REQ-TOOLS-01: args {date: YYYY-MM-DD, duration_minutes: 1..1440}
const CheckCalendarSchema = z.object({
  call_id: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  duration_minutes: z.number().int().min(1).max(1440),
});

/** Build Berlin-TZ day window for a YYYY-MM-DD date string. */
function buildDayWindow(
  date: string,
  tz: string,
): { timeMin: string; timeMax: string } {
  // Parse as local date in Berlin TZ by getting the UTC offset
  // We use a fixed offset approach: +02:00 in summer, +01:00 in winter
  // Simplest robust approach: build ISO string with 00:00 and 23:59 using
  // Intl.DateTimeFormat to figure out current UTC offset for that date.
  const startLocal = new Date(`${date}T00:00:00`);
  const endLocal = new Date(`${date}T23:59:59`);

  // Get the UTC offset for Berlin for these dates
  const offsetMs = getUTCOffsetMs(startLocal, tz);
  const offsetSign = offsetMs >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMs);
  const offsetHH = String(Math.floor(absOffset / 3600000)).padStart(2, '0');
  const offsetMM = String(Math.floor((absOffset % 3600000) / 60000)).padStart(
    2,
    '0',
  );
  const offsetStr = `${offsetSign}${offsetHH}:${offsetMM}`;

  return {
    timeMin: `${date}T00:00:00${offsetStr}`,
    timeMax: `${date}T23:59:59${offsetStr}`,
  };
}

/** Get UTC offset in milliseconds for a given local Date in a timezone. */
function getUTCOffsetMs(localDate: Date, tz: string): number {
  try {
    // Use Intl to format UTC time as Berlin local, then compute diff
    const utcMs = localDate.getTime();
    // Parse what Berlin thinks that moment is
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(localDate);

    const get = (type: string) =>
      parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);

    const localMs = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    return Math.round((utcMs - localMs) / 60000) * 60000; // round to minute
  } catch {
    // Fallback to +02:00 (CEST)
    return 2 * 3600000;
  }
}

export interface CheckCalendarDeps {
  calendarClient?: () => Promise<calendar_v3.Calendar>;
  jsonlPath?: string;
  now?: () => number;
  timeoutMs?: number;
  timezone?: string;
}

export function makeVoiceCheckCalendar(deps: CheckCalendarDeps = {}) {
  const calendarClientFn = deps.calendarClient ?? (() => getCalendarClient());
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-calendar.jsonl');
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timezone = deps.timezone ?? TIMEZONE;

  return async function voiceCheckCalendar(args: unknown): Promise<unknown> {
    const start = now();

    // Zod parse — REQ-TOOLS-01 shape
    const parseResult = CheckCalendarSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }

    const { call_id, date, duration_minutes } = parseResult.data;

    // Build Europe/Berlin day window
    const { timeMin, timeMax } = buildDayWindow(date, timezone);

    let available = false;
    let conflicts: Array<{
      start: string | null;
      end: string | null;
      start_local: string | null;
      end_local: string | null;
      summary: string | null;
    }> = [];

    // Format an ISO timestamp as HH:mm in the configured timezone.
    // Fix for PSTN-test 20:23: bot was verbatim-reading UTC strings
    // (13:00Z) and saying "13 Uhr" instead of the Berlin-local 15:00.
    const fmtLocal = (iso: string | null | undefined): string | null => {
      if (!iso) return null;
      try {
        const parts = new Intl.DateTimeFormat('de-DE', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(new Date(iso));
        const h = parts.find((p) => p.type === 'hour')?.value ?? '';
        const m = parts.find((p) => p.type === 'minute')?.value ?? '';
        return `${h}:${m}`;
      } catch {
        return null;
      }
    };

    try {
      const calendar = await calendarClientFn();

      // AbortController for timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let items: calendar_v3.Schema$Event[] = [];
      try {
        const res = await calendar.events.list(
          {
            calendarId: 'primary',
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 50,
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
            available: false,
            conflicts_count: 0,
            error: 'gcal_timeout',
          });
          return { ok: false, error: 'gcal_timeout' };
        }
        throw err;
      }
      clearTimeout(timer);

      // Compute available: total day = 1440 min, subtract busy durations
      let busyMinutes = 0;
      for (const e of items) {
        const s = e.start?.dateTime ?? e.start?.date;
        const en = e.end?.dateTime ?? e.end?.date;
        if (s && en) {
          const durMs = new Date(en).getTime() - new Date(s).getTime();
          if (durMs > 0) busyMinutes += durMs / 60000;
        }
      }
      const freeMinutes = 1440 - busyMinutes;
      available = freeMinutes >= duration_minutes;

      conflicts = items.map((e) => {
        const s = e.start?.dateTime ?? e.start?.date ?? null;
        const en = e.end?.dateTime ?? e.end?.date ?? null;
        return {
          start: s,
          end: en,
          start_local: fmtLocal(s),
          end_local: fmtLocal(en),
          summary: e.summary ?? null,
        };
      });

      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_check_done',
        call_id: call_id ?? null,
        tool: 'voice.check_calendar',
        latency_ms: now() - start,
        available,
        conflicts_count: conflicts.length,
      });

      return { ok: true, result: { available, conflicts } };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.warn({ event: 'voice_check_calendar_error', err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_check_done',
        call_id: call_id ?? null,
        tool: 'voice.check_calendar',
        latency_ms: now() - start,
        available: false,
        conflicts_count: 0,
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
