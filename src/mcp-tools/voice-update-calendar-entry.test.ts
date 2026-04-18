import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import { makeVoiceUpdateCalendarEntry } from './voice-update-calendar-entry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcal-update-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-calendar.jsonl');

interface ExistingEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: string;
}

function makeCalendarClient(existing: ExistingEvent | null) {
  const getMock = vi.fn().mockImplementation(() => {
    if (!existing) {
      const err = new Error('Not Found') as Error & { code: number };
      err.code = 404;
      throw err;
    }
    return Promise.resolve({ data: existing });
  });
  const patchMock = vi.fn().mockResolvedValue({ data: existing ?? {} });
  const client = { events: { get: getMock, patch: patchMock } };
  return { client, getMock, patchMock };
}

describe('makeVoiceUpdateCalendarEntry (REQ-TOOLS-12)', () => {
  it('happy path: title-only patch', async () => {
    const { client, patchMock } = makeCalendarClient({
      id: 'evt-1',
      summary: 'Old Title',
      start: { dateTime: '2026-04-20T16:00:00+02:00' },
      end: { dateTime: '2026-04-20T17:00:00+02:00' },
    });
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'upd-1',
      event_id: 'evt-1',
      fields_to_update: { title: 'New Title' },
    });

    expect(result).toMatchObject({
      ok: true,
      result: { updated: true, event_id: 'evt-1' },
    });
    expect(patchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        eventId: 'evt-1',
        requestBody: { summary: 'New Title' },
      }),
      expect.anything(),
    );
  });

  it('time-only update reuses existing date+duration to compute start+end', async () => {
    const { client, patchMock } = makeCalendarClient({
      id: 'evt-2',
      summary: 'Joggen',
      start: { dateTime: '2026-04-20T16:00:00+02:00' },
      end: { dateTime: '2026-04-20T17:00:00+02:00' },
    });
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await handler({
      event_id: 'evt-2',
      fields_to_update: { time: '17:00' },
    });

    const call = patchMock.mock.calls[0]?.[0] as {
      requestBody: { start?: { dateTime?: string }; end?: { dateTime?: string } };
    };
    // start emitted as Berlin-local with offset; verify the absolute instant.
    const startMs = new Date(call.requestBody.start?.dateTime ?? '').getTime();
    const endMs = new Date(call.requestBody.end?.dateTime ?? '').getTime();
    expect(startMs).toBe(new Date('2026-04-20T17:00:00+02:00').getTime());
    // 60-min existing duration preserved → end at 18:00 Berlin
    expect(endMs - startMs).toBe(60 * 60 * 1000);
    expect(endMs).toBe(new Date('2026-04-20T18:00:00+02:00').getTime());
  });

  it('date+time+duration all together', async () => {
    const { client, patchMock } = makeCalendarClient({
      id: 'evt-3',
      summary: 'Meeting',
      start: { dateTime: '2026-04-20T10:00:00+02:00' },
      end: { dateTime: '2026-04-20T11:00:00+02:00' },
    });
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await handler({
      event_id: 'evt-3',
      fields_to_update: {
        date: '2026-04-21',
        time: '14:30',
        duration: 90,
      },
    });

    const call = patchMock.mock.calls[0]?.[0] as {
      requestBody: { start?: { dateTime?: string }; end?: { dateTime?: string } };
    };
    const startMs = new Date(call.requestBody.start?.dateTime ?? '').getTime();
    const endMs = new Date(call.requestBody.end?.dateTime ?? '').getTime();
    expect(startMs).toBe(new Date('2026-04-21T14:30:00+02:00').getTime());
    expect(endMs).toBe(new Date('2026-04-21T16:00:00+02:00').getTime());
  });

  it('location-only patch', async () => {
    const { client, patchMock } = makeCalendarClient({
      id: 'evt-4',
      summary: 'Termin',
      start: { dateTime: '2026-04-20T10:00:00+02:00' },
      end: { dateTime: '2026-04-20T11:00:00+02:00' },
    });
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await handler({
      event_id: 'evt-4',
      fields_to_update: { location: 'Maxstrasse 42' },
    });

    expect(patchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { location: 'Maxstrasse 42' },
      }),
      expect.anything(),
    );
  });

  it('not_found when event_id missing', async () => {
    const { client, patchMock } = makeCalendarClient(null);
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      event_id: 'phantom',
      fields_to_update: { title: 'X' },
    });
    expect(result).toMatchObject({ ok: false, error: 'not_found' });
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('zod rejects empty fields_to_update', async () => {
    const { client } = makeCalendarClient({
      id: 'evt-5',
      summary: 'X',
      start: { dateTime: '2026-04-20T10:00:00+02:00' },
      end: { dateTime: '2026-04-20T11:00:00+02:00' },
    });
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });
    await expect(
      handler({ event_id: 'evt-5', fields_to_update: {} }),
    ).rejects.toThrow(BadRequestError);
  });

  it('zod rejects missing event_id', async () => {
    const { client } = makeCalendarClient({
      id: 'x',
      start: { dateTime: '2026-04-20T10:00:00+02:00' },
      end: { dateTime: '2026-04-20T11:00:00+02:00' },
    });
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });
    await expect(
      handler({ fields_to_update: { title: 'X' } }),
    ).rejects.toThrow(BadRequestError);
  });

  it('zod rejects invalid time format', async () => {
    const { client } = makeCalendarClient({
      id: 'x',
      start: { dateTime: '2026-04-20T10:00:00+02:00' },
      end: { dateTime: '2026-04-20T11:00:00+02:00' },
    });
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });
    await expect(
      handler({
        event_id: 'x',
        fields_to_update: { time: '5pm' },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('JSONL: calendar_update_done logged with fields_changed list', async () => {
    const { client } = makeCalendarClient({
      id: 'evt-jsonl',
      summary: 'Old',
      start: { dateTime: '2026-04-20T10:00:00+02:00' },
      end: { dateTime: '2026-04-20T11:00:00+02:00' },
    });
    const jsonlPath = JSONL_PATH();
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath,
    });

    await handler({
      call_id: 'jsonl-test',
      event_id: 'evt-jsonl',
      fields_to_update: { title: 'New', location: 'Where' },
    });

    const last = JSON.parse(
      fs
        .readFileSync(jsonlPath, 'utf8')
        .trim()
        .split('\n')
        .pop() ?? '{}',
    );
    expect(last.event).toBe('calendar_update_done');
    expect(last.tool).toBe('voice.update_calendar_entry');
    expect(last.updated).toBe(true);
    expect(last.event_id).toBe('evt-jsonl');
    expect(last.fields_changed).toEqual(
      expect.arrayContaining(['title', 'location']),
    );
  });

  it('timeout on get returns gcal_timeout', async () => {
    const getMock = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        }),
    );
    const client = { events: { get: getMock, patch: vi.fn() } };
    const handler = makeVoiceUpdateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
      timeoutMs: 10,
    });

    const result = await handler({
      event_id: 'evt-slow',
      fields_to_update: { title: 'X' },
    });
    expect(result).toMatchObject({ ok: false, error: 'gcal_timeout' });
  });
});
