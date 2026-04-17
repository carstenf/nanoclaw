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
const DEFAULT_TZ = process.env.GCALENDAR_DEFAULT_TZ ?? 'Europe/Berlin';

// Simple email regex for attendee validation
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CreateEntrySchema = z.object({
  call_id: z.string().optional(),
  summary: z.string().min(1).max(200),
  start: z.string(),
  end: z.string(),
  description: z.string().max(2000).optional(),
  location: z.string().max(200).optional(),
  calendarId: z.string().default('primary'),
  attendees: z.array(z.string()).max(10).optional(),
});

function validateDates(start: string, end: string): void {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (isNaN(s)) throw new BadRequestError('start', 'valid ISO8601 date');
  if (isNaN(e)) throw new BadRequestError('end', 'valid ISO8601 date');
  if (e <= s) throw new BadRequestError('end', 'greater than start');
}

function validateAttendees(attendees?: string[]): void {
  if (!attendees) return;
  for (const email of attendees) {
    if (!EMAIL_RE.test(email)) {
      throw new BadRequestError(
        'attendees',
        `valid email address (got: ${email})`,
      );
    }
  }
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

    // Zod parse
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
      summary,
      start: startTime,
      end: endTime,
      description,
      location,
      calendarId,
      attendees,
    } = parseResult.data;

    // Additional validations
    if (summary.trim().length === 0) {
      throw new BadRequestError('summary', 'non-empty string');
    }
    validateDates(startTime, endTime);
    validateAttendees(attendees);

    try {
      const calendar = await calendarClientFn();

      const requestBody: calendar_v3.Schema$Event = {
        summary,
        start: { dateTime: startTime, timeZone: defaultTz },
        end: { dateTime: endTime, timeZone: defaultTz },
      };

      if (description !== undefined) requestBody.description = description;
      if (location !== undefined) requestBody.location = location;
      if (attendees && attendees.length > 0) {
        requestBody.attendees = attendees.map((email) => ({ email }));
      }

      // AbortController for timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let eventId: string | null | undefined;
      let htmlLink: string | null | undefined;

      try {
        const res = await calendar.events.insert(
          { calendarId, requestBody },
          { signal: controller.signal as never },
        );
        eventId = res.data.id;
        htmlLink = res.data.htmlLink;
      } catch (err) {
        clearTimeout(timer);
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.includes('aborted'));
        if (isAbort) {
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'calendar_create_done',
            call_id: call_id ?? null,
            tool: 'voice.create_calendar_entry',
            latency_ms: now() - start,
            event_id: null,
            calendar_id: calendarId,
            error: 'gcal_timeout',
          });
          return { ok: false, error: 'gcal_timeout' };
        }
        throw err;
      }
      clearTimeout(timer);

      // JSONL — no PII (no summary, no description, no attendee emails)
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_create_done',
        call_id: call_id ?? null,
        tool: 'voice.create_calendar_entry',
        latency_ms: now() - start,
        event_id: eventId ?? null,
        calendar_id: calendarId,
      });

      return { ok: true, result: { eventId, htmlLink } };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.warn({ event: 'voice_create_calendar_error', err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'calendar_create_done',
        call_id: call_id ?? null,
        tool: 'voice.create_calendar_entry',
        latency_ms: now() - start,
        event_id: null,
        calendar_id: 'primary',
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
