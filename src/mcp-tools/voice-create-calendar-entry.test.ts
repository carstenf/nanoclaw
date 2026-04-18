import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import { makeVoiceCreateCalendarEntry } from './voice-create-calendar-entry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcal-create-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-calendar.jsonl');

function makeCalendarClient(
  listItems: object[] = [],
  insertId = 'new-event-id',
) {
  const listMock = vi.fn().mockResolvedValue({ data: { items: listItems } });
  const insertMock = vi.fn().mockResolvedValue({ data: { id: insertId } });
  const client = { events: { list: listMock, insert: insertMock } };
  return { client, listMock, insertMock };
}

describe('makeVoiceCreateCalendarEntry (REQ-TOOLS-02)', () => {
  it('happy path: new event created, returns {id}', async () => {
    const { client, insertMock, listMock } = makeCalendarClient([], 'evt-new-1');

    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'smoke-1',
      title: '03-09 Smoke',
      date: '2026-04-20',
      time: '15:00',
      duration: 30,
    });

    expect(result).toMatchObject({
      ok: true,
      result: { id: 'evt-new-1' },
    });

    // list called to check idempotency, insert called once
    expect(listMock).toHaveBeenCalledOnce();
    expect(insertMock).toHaveBeenCalledOnce();

    // insert called with correct REQ-TOOLS-02 body
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          summary: '03-09 Smoke',
          start: expect.objectContaining({ timeZone: 'Europe/Berlin' }),
          end: expect.objectContaining({ timeZone: 'Europe/Berlin' }),
        }),
      }),
      expect.anything(),
    );
  });

  it('idempotent: second call with same title+date+time+duration → same id, no insert', async () => {
    const existingId = 'evt-existing-123';
    const { client, insertMock } = makeCalendarClient(
      [
        {
          id: existingId,
          summary: '03-09 Smoke',
          start: { dateTime: '2026-04-20T15:00:00+02:00' },
          end: { dateTime: '2026-04-20T15:30:00+02:00' },
        },
      ],
      'should-not-be-used',
    );

    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = (await handler({
      call_id: 'smoke-dedup',
      title: '03-09 Smoke',
      date: '2026-04-20',
      time: '15:00',
      duration: 30,
    })) as { ok: true; result: { id: string; was_duplicate: boolean } };

    expect(result.ok).toBe(true);
    expect(result.result.id).toBe(existingId);
    expect(result.result.was_duplicate).toBe(true);
    // insert NOT called — idempotent
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('travel_buffer_before_min > 0 creates additional Anfahrt blocker event', async () => {
    const { client, insertMock } = makeCalendarClient([], 'evt-main');

    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await handler({
      call_id: 'smoke-buffer',
      title: 'Termin mit Puffer',
      date: '2026-04-20',
      time: '15:00',
      duration: 60,
      travel_buffer_before_min: 30,
    });

    // insert called twice: main event + Anfahrt blocker
    expect(insertMock).toHaveBeenCalledTimes(2);
    const calls = insertMock.mock.calls.map((c) => c[0].requestBody);
    const summaries = calls.map((b: { summary: string }) => b.summary);
    expect(summaries).toContain('Anfahrt');
  });

  it('invalid date format → throws BadRequestError', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ title: 'X', date: 'not-a-date', time: '10:00', duration: 30 }),
    ).rejects.toThrow(BadRequestError);
  });

  it('invalid time format → throws BadRequestError', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ title: 'X', date: '2026-04-20', time: '9:00', duration: 30 }),
    ).rejects.toThrow(BadRequestError);
  });

  it('duration=0 → throws BadRequestError (zod min 1)', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ title: 'X', date: '2026-04-20', time: '10:00', duration: 0 }),
    ).rejects.toThrow(BadRequestError);
  });

  it('zod rejects missing title (required field)', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ date: '2026-04-20', time: '10:00', duration: 30 }),
    ).rejects.toThrow(BadRequestError);
  });

  it('JSONL: calendar_create_done written with was_duplicate, no PII', async () => {
    const { client } = makeCalendarClient([], 'evt-pii-test');
    const jsonlPath = JSONL_PATH();

    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath,
    });

    await handler({
      call_id: 'pii-check',
      title: 'Secret Appointment',
      date: '2026-04-20',
      time: '14:00',
      duration: 60,
      location: 'Secret Location',
    });

    const logContent = fs.readFileSync(jsonlPath, 'utf8').trim();
    const entry = JSON.parse(logContent.split('\n')[0]);

    expect(entry.event).toBe('calendar_create_done');
    expect(entry.call_id).toBe('pii-check');
    expect(typeof entry.was_duplicate).toBe('boolean');
    // PII check
    expect(logContent).not.toContain('Secret Appointment');
    expect(logContent).not.toContain('Secret Location');
  });
});
