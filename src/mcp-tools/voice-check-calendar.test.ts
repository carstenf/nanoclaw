import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import { makeVoiceCheckCalendar } from './voice-check-calendar.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcal-check-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-calendar.jsonl');

function makeCalendarClient(items: object[] = []) {
  const listMock = vi.fn().mockResolvedValue({
    data: { items },
  });
  const client = { events: { list: listMock } };
  return { client, listMock };
}

describe('makeVoiceCheckCalendar', () => {
  it('happy path: returns busy array from calendar events', async () => {
    const { client, listMock } = makeCalendarClient([
      {
        id: 'evt-1',
        summary: 'Team Meeting',
        start: { dateTime: '2026-04-17T10:00:00+02:00' },
        end: { dateTime: '2026-04-17T11:00:00+02:00' },
      },
      {
        id: 'evt-2',
        summary: 'Lunch',
        start: { dateTime: '2026-04-17T12:00:00+02:00' },
        end: { dateTime: '2026-04-17T13:00:00+02:00' },
      },
    ]);

    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'smoke-1',
      timeMin: '2026-04-17T00:00:00Z',
      timeMax: '2026-04-18T00:00:00Z',
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        busy: [
          expect.objectContaining({ eventId: 'evt-1', summary: 'Team Meeting' }),
          expect.objectContaining({ eventId: 'evt-2', summary: 'Lunch' }),
        ],
      },
    });

    // calendar.events.list called with correct params
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        timeMin: '2026-04-17T00:00:00Z',
        timeMax: '2026-04-18T00:00:00Z',
        singleEvents: true,
        orderBy: 'startTime',
      }),
      expect.anything(),
    );
  });

  it('invalid date strings throw BadRequestError', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-2',
        timeMin: 'not-a-date',
        timeMax: '2026-04-18T00:00:00Z',
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('end <= start throws BadRequestError', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-3',
        timeMin: '2026-04-18T00:00:00Z',
        timeMax: '2026-04-17T00:00:00Z', // end < start
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('timeout returns ok:false with error gcal_timeout', async () => {
    const listMock = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          // never resolves — will be aborted
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        }),
    );
    const client = { events: { list: listMock } };

    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
      timeoutMs: 10, // very short timeout to trigger abort
    });

    const result = await handler({
      call_id: 'smoke-timeout',
      timeMin: '2026-04-17T00:00:00Z',
      timeMax: '2026-04-18T00:00:00Z',
    });

    expect(result).toMatchObject({ ok: false, error: 'gcal_timeout' });
  });

  it('appends calendar_check_done event to JSONL on success', async () => {
    const { client } = makeCalendarClient([
      {
        id: 'evt-3',
        summary: 'Test',
        start: { dateTime: '2026-04-17T09:00:00Z' },
        end: { dateTime: '2026-04-17T10:00:00Z' },
      },
    ]);

    const jsonlPath = JSONL_PATH();
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath,
    });

    await handler({
      call_id: 'smoke-jsonl',
      timeMin: '2026-04-17T00:00:00Z',
      timeMax: '2026-04-18T00:00:00Z',
    });

    const logContent = fs.readFileSync(jsonlPath, 'utf8').trim();
    const logEntry = JSON.parse(logContent);

    expect(logEntry.event).toBe('calendar_check_done');
    expect(logEntry.call_id).toBe('smoke-jsonl');
    expect(logEntry.tool).toBe('voice.check_calendar');
    expect(typeof logEntry.latency_ms).toBe('number');
    expect(logEntry.result_count).toBe(1);
    expect(logEntry.calendar_id).toBe('primary');

    // PII check: no summary text in JSONL
    expect(logContent).not.toContain('Test');
  });

  it('missing call_id still writes JSONL with call_id:null', async () => {
    const { client } = makeCalendarClient([]);
    const jsonlPath = JSONL_PATH();

    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath,
    });

    await handler({
      timeMin: '2026-04-17T00:00:00Z',
      timeMax: '2026-04-18T00:00:00Z',
    });

    const logEntry = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim());
    expect(logEntry.call_id).toBeNull();
  });
});
