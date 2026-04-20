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

describe('makeVoiceCheckCalendar (REQ-TOOLS-01)', () => {
  it('happy path available=true: day with < duration_minutes busy → available', async () => {
    const { client, listMock } = makeCalendarClient([
      {
        id: 'evt-1',
        summary: 'Team Meeting',
        start: { dateTime: '2026-04-20T10:00:00+02:00' },
        end: { dateTime: '2026-04-20T11:00:00+02:00' }, // 60 min busy
      },
    ]);

    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'smoke-1',
      date: '2026-04-20',
      duration_minutes: 90, // need 90 min free, only 60 busy → 1380 free → available
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        available: true,
        conflicts: [
          expect.objectContaining({
            start: '2026-04-20T10:00:00+02:00',
            end: '2026-04-20T11:00:00+02:00',
            summary: 'Team Meeting',
          }),
        ],
      },
    });

    // calendar.events.list called with date-window args
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        singleEvents: true,
        orderBy: 'startTime',
      }),
      expect.anything(),
    );
  });

  it('happy path available=false: day fully booked → not available', async () => {
    // 1440 min total day, fill with events totalling >= 1440 - duration
    const events = Array.from({ length: 24 }, (_, i) => ({
      id: `evt-${i}`,
      summary: `Block ${i}`,
      start: {
        dateTime: `2026-04-20T${String(i).padStart(2, '0')}:00:00+02:00`,
      },
      end: { dateTime: `2026-04-20T${String(i).padStart(2, '0')}:59:00+02:00` },
    }));

    const { client } = makeCalendarClient(events);
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = (await handler({
      call_id: 'smoke-full',
      date: '2026-04-20',
      duration_minutes: 60,
    })) as { ok: true; result: { available: boolean; conflicts: unknown[] } };

    expect(result.ok).toBe(true);
    // 24 events × 59 min = 1416 min busy; 1440 - 1416 = 24 min free < 60 min needed
    expect(result.result.available).toBe(false);
  });

  it('empty day → available=true, conflicts=[]', async () => {
    const { client } = makeCalendarClient([]);
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      date: '2026-04-20',
      duration_minutes: 60,
    });

    expect(result).toMatchObject({
      ok: true,
      result: { available: true, conflicts: [] },
    });
  });

  it('invalid date format → throws BadRequestError', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ date: 'not-a-date', duration_minutes: 60 }),
    ).rejects.toThrow(BadRequestError);
  });

  it('duration_minutes=0 → throws BadRequestError (zod min 1)', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ date: '2026-04-20', duration_minutes: 0 }),
    ).rejects.toThrow(BadRequestError);
  });

  it('duration_minutes=1441 → throws BadRequestError (zod max 1440)', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ date: '2026-04-20', duration_minutes: 1441 }),
    ).rejects.toThrow(BadRequestError);
  });

  it('zod rejects empty args (missing date + duration_minutes)', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(handler({})).rejects.toThrow(BadRequestError);
  });

  it('JSONL: calendar_check_done written with available flag, no PII', async () => {
    const { client } = makeCalendarClient([
      {
        id: 'evt-pii',
        summary: 'Secret Meeting',
        start: { dateTime: '2026-04-20T09:00:00+02:00' },
        end: { dateTime: '2026-04-20T10:00:00+02:00' },
      },
    ]);

    const jsonlPath = JSONL_PATH();
    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath,
    });

    await handler({
      call_id: 'pii-test',
      date: '2026-04-20',
      duration_minutes: 30,
    });

    const logContent = fs.readFileSync(jsonlPath, 'utf8').trim();
    const entry = JSON.parse(logContent);

    expect(entry.event).toBe('calendar_check_done');
    expect(entry.call_id).toBe('pii-test');
    expect(entry.tool).toBe('voice_check_calendar');
    expect(typeof entry.available).toBe('boolean');
    expect(typeof entry.conflicts_count).toBe('number');
    expect(typeof entry.latency_ms).toBe('number');
    // PII: no summary text in JSONL
    expect(logContent).not.toContain('Secret Meeting');
  });

  it('timeout returns ok:false with error gcal_timeout', async () => {
    const listMock = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        }),
    );
    const client = { events: { list: listMock } };

    const handler = makeVoiceCheckCalendar({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
      timeoutMs: 10,
    });

    const result = await handler({
      call_id: 'smoke-timeout',
      date: '2026-04-20',
      duration_minutes: 60,
    });

    expect(result).toMatchObject({ ok: false, error: 'gcal_timeout' });
  });
});
