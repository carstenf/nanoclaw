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
const DEFAULT_TZ = process.env.TZ ?? 'Europe/Berlin';

// REQ-TOOLS-02: args {title, date, time, duration, location?, travel_buffer_before_min?, travel_buffer_after_min?}
export const CreateEntrySchema = z.object({
  call_id: z.string().optional(),
  title: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:mm (24h)'),
  duration: z.number().int().min(1).max(1440),
  location: z.string().max(200).optional(),
  travel_buffer_before_min: z.number().int().min(0).max(180).optional(),
  travel_buffer_after_min: z.number().int().min(0).max(180).optional(),
});

/** Build a Berlin-offset ISO8601 datetime string from date + time. */
function buildIso(date: string, time: string, tz: string): string {
  // Determine UTC offset for this date+time in given TZ
  const localDate = new Date(`${date}T${time}:00`);
  const offsetMs = getUTCOffsetMs(localDate, tz);
  const sign = offsetMs >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMs);
  const hh = String(Math.floor(abs / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600000) / 60000)).padStart(2, '0');
  return `${date}T${time}:00${sign}${hh}:${mm}`;
}

function getUTCOffsetMs(localDate: Date, tz: string): number {
  try {
    const utcMs = localDate.getTime();
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
    return Math.round((localMs - utcMs) / 60000) * 60000;
  } catch {
    return 2 * 3600000; // fallback +02:00 CEST
  }
}

function addMinutesToIso(isoStr: string, minutes: number): string {
  const d = new Date(isoStr);
  d.setTime(d.getTime() + minutes * 60000);
  return d.toISOString().replace('Z', '+00:00'); // keep UTC for computation; actual TZ preserved on insert
}

export interface CreateCalendarEntryDeps {
  calendarClient?: () => Promise<calendar_v3.Calendar>;
  jsonlPath?: string;
  now?: () => number;
  timeoutMs?: number;
  defaultTz?: string;
}

export function makeVoiceCreateCalendarEntry(
  deps: CreateCalendarEntryDeps = {},
) {
  const calendarClientFn = deps.calendarClient ?? (() => getCalendarClient());
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-calendar.jsonl');
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultTz = deps.defaultTz ?? DEFAULT_TZ;

  return async function voiceCreateCalendarEntry(
    args: unknown,
  ): Promise<unknown> {
    const start = now();

    // Zod parse — REQ-TOOLS-02 shape
    const parseResult = CreateEntrySchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }

    const {
      call_id,
      title,
      date,
      time,
      duration,
      location,
      travel_buffer_before_min,
      travel_buffer_after_min,
    } = parseResult.data;

    // Build start/end ISO strings with Europe/Berlin offset
    const startIso = buildIso(date, time, defaultTz);
    const endIso = addMinutesToIso(startIso, duration);

    try {
      const calendar = await calendarClientFn();

      // ── Idempotency check: list events at start window ──
      const controller1 = new AbortController();
      const timer1 = setTimeout(() => controller1.abort(), timeoutMs);
      let existingItems: calendar_v3.Schema$Event[] = [];
      try {
        const listRes = await calendar.events.list(
          {
            calendarId: 'primary',
            timeMin: startIso,
            timeMax: endIso,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 20,
          },
          { signal: controller1.signal as never },
        );
        existingItems = listRes.data.items ?? [];
      } catch {
        // non-fatal for idempotency — proceed with insert
      } finally {
        clearTimeout(timer1);
      }

      // Check for title+start match
      const existing = existingItems.find(
        (e) =>
          e.summary === title &&
          (e.start?.dateTime?.startsWith(date) || e.start?.date === date),
      );

      if (existing?.id) {
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'calendar_create_done',
          call_id: call_id ?? null,
          tool: 'voice_create_calendar_entry',
          latency_ms: now() - start,
          event_id: existing.id,
          calendar_id: 'primary',
          was_duplicate: true,
        });
        return { ok: true, result: { id: existing.id, was_duplicate: true } };
      }

      // ── Insert main event ──
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs);

      let eventId: string | null | undefined;
      try {
        const requestBody: calendar_v3.Schema$Event = {
          summary: title,
          start: { dateTime: startIso, timeZone: defaultTz },
          end: { dateTime: endIso, timeZone: defaultTz },
        };
        if (location !== undefined) requestBody.location = location;

        const res = await calendar.events.insert(
          { calendarId: 'primary', requestBody },
          { signal: controller2.signal as never },
        );
        eventId = res.data.id;
      } catch (err) {
        clearTimeout(timer2);
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.includes('aborted'));
        if (isAbort) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_create_done',
            call_id: call_id ?? null,
            tool: 'voice_create_calendar_entry',
            latency_ms: now() - start,
            event_id: null,
            calendar_id: 'primary',
            was_duplicate: false,
            error: 'gcal_timeout',
          });
          return { ok: false, error: 'gcal_timeout' };
        }
        throw err;
      }
      clearTimeout(timer2);

      // ── Travel buffers (non-atomic caveat documented) ──
      if (travel_buffer_before_min && travel_buffer_before_min > 0) {
        try {
          const bufStart = addMinutesToIso(startIso, -travel_buffer_before_min);
          await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
              summary: 'Anfahrt',
              start: { dateTime: bufStart, timeZone: defaultTz },
              end: { dateTime: startIso, timeZone: defaultTz },
            },
          });
        } catch {
          // non-fatal: travel buffer insert failure does not affect main event
          logger.warn({
            event: 'voice_create_calendar_buffer_error',
            dir: 'before',
          });
        }
      }

      if (travel_buffer_after_min && travel_buffer_after_min > 0) {
        try {
          const bufEnd = addMinutesToIso(endIso, travel_buffer_after_min);
          await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
              summary: 'Rueckfahrt',
              start: { dateTime: endIso, timeZone: defaultTz },
              end: { dateTime: bufEnd, timeZone: defaultTz },
            },
          });
        } catch {
          logger.warn({
            event: 'voice_create_calendar_buffer_error',
            dir: 'after',
          });
        }
      }

      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_create_done',
        call_id: call_id ?? null,
        tool: 'voice_create_calendar_entry',
        latency_ms: now() - start,
        event_id: eventId ?? null,
        calendar_id: 'primary',
        was_duplicate: false,
      });

      return {
        ok: true,
        result: { id: eventId ?? null, was_duplicate: false },
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.warn({ event: 'voice_create_calendar_error', err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_create_done',
        call_id: call_id ?? null,
        tool: 'voice_create_calendar_entry',
        latency_ms: now() - start,
        event_id: null,
        calendar_id: 'primary',
        was_duplicate: false,
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
