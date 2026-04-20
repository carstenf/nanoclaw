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

export const FieldsSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'time must be HH:mm (24h)')
      .optional(),
    duration: z.number().int().min(1).max(1440).optional(),
    location: z.string().max(200).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.date !== undefined ||
      v.time !== undefined ||
      v.duration !== undefined ||
      v.location !== undefined,
    { message: 'fields_to_update must contain at least one field' },
  );

// REQ-TOOLS-12: args {event_id, fields_to_update}
export const UpdateEntrySchema = z.object({
  call_id: z.string().optional(),
  event_id: z.string().min(1),
  fields_to_update: FieldsSchema,
});

function buildIso(date: string, time: string, tz: string): string {
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
    return 2 * 3600000;
  }
}

function addMinutesToIso(isoStr: string, minutes: number): string {
  const d = new Date(isoStr);
  d.setTime(d.getTime() + minutes * 60000);
  // Keep `+00:00` suffix (not Z) to match voice-create-calendar-entry's
  // wire format — Google Calendar reads the actual TZ from the timeZone field.
  return d.toISOString().replace('Z', '+00:00');
}

function extractDateTimeParts(
  startIso: string | null | undefined,
  tz: string,
): { date: string; time: string } | null {
  if (!startIso) return null;
  try {
    const dt = new Date(startIso);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(dt);
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const time = `${get('hour')}:${get('minute')}`;
    return { date, time };
  } catch {
    return null;
  }
}

function durationMinutes(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): number | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms <= 0) return null;
  return Math.round(ms / 60000);
}

export interface UpdateCalendarEntryDeps {
  calendarClient?: () => Promise<calendar_v3.Calendar>;
  jsonlPath?: string;
  now?: () => number;
  timeoutMs?: number;
  defaultTz?: string;
}

export function makeVoiceUpdateCalendarEntry(
  deps: UpdateCalendarEntryDeps = {},
) {
  const calendarClientFn = deps.calendarClient ?? (() => getCalendarClient());
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-calendar.jsonl');
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultTz = deps.defaultTz ?? DEFAULT_TZ;

  return async function voiceUpdateCalendarEntry(
    args: unknown,
  ): Promise<unknown> {
    const start = now();

    const parseResult = UpdateEntrySchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }
    const { call_id, event_id, fields_to_update } = parseResult.data;

    try {
      const calendar = await calendarClientFn();

      // ── Read existing event so we can apply partial updates ──
      const controllerG = new AbortController();
      const timerG = setTimeout(() => controllerG.abort(), timeoutMs);
      let existing: calendar_v3.Schema$Event;
      try {
        const getRes = await calendar.events.get(
          { calendarId: 'primary', eventId: event_id },
          { signal: controllerG.signal as never },
        );
        existing = getRes.data;
      } catch (err) {
        clearTimeout(timerG);
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.includes('aborted'));
        if (isAbort) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_update_done',
            call_id: call_id ?? null,
            tool: 'voice.update_calendar_entry',
            latency_ms: now() - start,
            event_id,
            updated: false,
            error: 'gcal_timeout',
          });
          return { ok: false, error: 'gcal_timeout' };
        }
        const httpErr = err as { code?: number; status?: number };
        const code = httpErr?.code ?? httpErr?.status;
        if (code === 404 || code === 410) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_update_done',
            call_id: call_id ?? null,
            tool: 'voice.update_calendar_entry',
            latency_ms: now() - start,
            event_id,
            updated: false,
            error: 'not_found',
          });
          return { ok: false, error: 'not_found' };
        }
        throw err;
      }
      clearTimeout(timerG);

      // ── Compute new start/end if date/time/duration changed ──
      const existStart = existing.start?.dateTime ?? null;
      const existEnd = existing.end?.dateTime ?? null;
      const existParts = extractDateTimeParts(existStart, defaultTz);
      const existDuration = durationMinutes(existStart, existEnd);

      const newDate = fields_to_update.date ?? existParts?.date ?? null;
      const newTime = fields_to_update.time ?? existParts?.time ?? null;
      const newDuration = fields_to_update.duration ?? existDuration ?? null;

      const patch: calendar_v3.Schema$Event = {};
      if (fields_to_update.title !== undefined)
        patch.summary = fields_to_update.title;
      if (fields_to_update.location !== undefined)
        patch.location = fields_to_update.location;

      const timeChanged =
        fields_to_update.date !== undefined ||
        fields_to_update.time !== undefined ||
        fields_to_update.duration !== undefined;
      if (timeChanged) {
        if (!newDate || !newTime || !newDuration) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_update_done',
            call_id: call_id ?? null,
            tool: 'voice.update_calendar_entry',
            latency_ms: now() - start,
            event_id,
            updated: false,
            error: 'incomplete_time_fields',
          });
          throw new BadRequestError(
            'fields_to_update',
            'date+time+duration cannot be derived from existing event',
          );
        }
        const startIso = buildIso(newDate, newTime, defaultTz);
        const endIso = addMinutesToIso(startIso, newDuration);
        patch.start = { dateTime: startIso, timeZone: defaultTz };
        patch.end = { dateTime: endIso, timeZone: defaultTz };
      }

      // ── PATCH the event ──
      const controllerP = new AbortController();
      const timerP = setTimeout(() => controllerP.abort(), timeoutMs);
      try {
        await calendar.events.patch(
          { calendarId: 'primary', eventId: event_id, requestBody: patch },
          { signal: controllerP.signal as never },
        );
        clearTimeout(timerP);
      } catch (err) {
        clearTimeout(timerP);
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.includes('aborted'));
        if (isAbort) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_update_done',
            call_id: call_id ?? null,
            tool: 'voice.update_calendar_entry',
            latency_ms: now() - start,
            event_id,
            updated: false,
            error: 'gcal_timeout',
          });
          return { ok: false, error: 'gcal_timeout' };
        }
        throw err;
      }

      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_update_done',
        call_id: call_id ?? null,
        tool: 'voice.update_calendar_entry',
        latency_ms: now() - start,
        event_id,
        updated: true,
        fields_changed: Object.keys(fields_to_update),
      });

      return { ok: true, result: { updated: true, event_id } };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.warn({ event: 'voice_update_calendar_error', err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_update_done',
        call_id: call_id ?? null,
        tool: 'voice.update_calendar_entry',
        latency_ms: now() - start,
        event_id,
        updated: false,
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
    /* non-fatal */
  }
}
