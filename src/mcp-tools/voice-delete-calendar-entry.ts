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

// REQ-TOOLS-11: args either {event_id} or {title, date}.
const DeleteEntrySchema = z
  .object({
    call_id: z.string().optional(),
    event_id: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
  })
  .refine((v) => !!v.event_id || (!!v.title && !!v.date), {
    message: 'either event_id, or both title and date are required',
    path: ['event_id'],
  });

function buildDayWindow(
  date: string,
  tz: string,
): { timeMin: string; timeMax: string } {
  const startLocal = new Date(`${date}T00:00:00`);
  const offsetMs = getUTCOffsetMs(startLocal, tz);
  const sign = offsetMs >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMs);
  const hh = String(Math.floor(abs / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600000) / 60000)).padStart(2, '0');
  const off = `${sign}${hh}:${mm}`;
  return {
    timeMin: `${date}T00:00:00${off}`,
    timeMax: `${date}T23:59:59${off}`,
  };
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
    return Math.round((utcMs - localMs) / 60000) * 60000;
  } catch {
    return 2 * 3600000;
  }
}

export interface DeleteCalendarEntryDeps {
  calendarClient?: () => Promise<calendar_v3.Calendar>;
  jsonlPath?: string;
  now?: () => number;
  timeoutMs?: number;
  defaultTz?: string;
}

export function makeVoiceDeleteCalendarEntry(
  deps: DeleteCalendarEntryDeps = {},
) {
  const calendarClientFn = deps.calendarClient ?? (() => getCalendarClient());
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-calendar.jsonl');
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultTz = deps.defaultTz ?? DEFAULT_TZ;

  return async function voiceDeleteCalendarEntry(
    args: unknown,
  ): Promise<unknown> {
    const start = now();

    const parseResult = DeleteEntrySchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }
    const { call_id, title, date } = parseResult.data;
    let { event_id } = parseResult.data;

    try {
      const calendar = await calendarClientFn();

      // ── Resolve event_id from title+date if not provided ──
      if (!event_id && title && date) {
        const { timeMin, timeMax } = buildDayWindow(date, defaultTz);
        const controllerL = new AbortController();
        const timerL = setTimeout(() => controllerL.abort(), timeoutMs);
        let items: calendar_v3.Schema$Event[] = [];
        try {
          const listRes = await calendar.events.list(
            {
              calendarId: 'primary',
              timeMin,
              timeMax,
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 50,
            },
            { signal: controllerL.signal as never },
          );
          items = listRes.data.items ?? [];
        } catch (err) {
          clearTimeout(timerL);
          const isAbort =
            err instanceof Error &&
            (err.name === 'AbortError' || err.message.includes('aborted'));
          if (isAbort) {
            appendJsonl(jsonlPath, {
              ts: new Date().toISOString(),
              event: 'calendar_delete_done',
              call_id: call_id ?? null,
              tool: 'voice.delete_calendar_entry',
              latency_ms: now() - start,
              event_id: null,
              deleted: false,
              error: 'gcal_timeout',
            });
            return { ok: false, error: 'gcal_timeout' };
          }
          throw err;
        }
        clearTimeout(timerL);

        const match = items.find(
          (e) => (e.summary ?? '').toLowerCase() === title.toLowerCase(),
        );
        if (!match?.id) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_delete_done',
            call_id: call_id ?? null,
            tool: 'voice.delete_calendar_entry',
            latency_ms: now() - start,
            event_id: null,
            deleted: false,
            error: 'not_found',
          });
          return { ok: false, error: 'not_found' };
        }
        event_id = match.id;
      }

      if (!event_id) {
        // Should not reach here given zod refine, but guard for type narrowing.
        throw new BadRequestError('event_id', 'event_id resolution failed');
      }

      // ── Delete event (idempotent: 404 → deleted:true) ──
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await calendar.events.delete(
          { calendarId: 'primary', eventId: event_id },
          { signal: controller.signal as never },
        );
        clearTimeout(timer);
      } catch (err) {
        clearTimeout(timer);
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.includes('aborted'));
        if (isAbort) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_delete_done',
            call_id: call_id ?? null,
            tool: 'voice.delete_calendar_entry',
            latency_ms: now() - start,
            event_id,
            deleted: false,
            error: 'gcal_timeout',
          });
          return { ok: false, error: 'gcal_timeout' };
        }
        // 404/410 → already-deleted → idempotent success
        const httpErr = err as { code?: number; status?: number };
        const code = httpErr?.code ?? httpErr?.status;
        if (code === 404 || code === 410) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_delete_done',
            call_id: call_id ?? null,
            tool: 'voice.delete_calendar_entry',
            latency_ms: now() - start,
            event_id,
            deleted: true,
            was_already_deleted: true,
          });
          return {
            ok: true,
            result: { deleted: true, event_id, was_already_deleted: true },
          };
        }
        throw err;
      }

      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_delete_done',
        call_id: call_id ?? null,
        tool: 'voice.delete_calendar_entry',
        latency_ms: now() - start,
        event_id,
        deleted: true,
      });

      return { ok: true, result: { deleted: true, event_id } };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.warn({ event: 'voice_delete_calendar_error', err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_delete_done',
        call_id: call_id ?? null,
        tool: 'voice.delete_calendar_entry',
        latency_ms: now() - start,
        event_id: event_id ?? null,
        deleted: false,
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
