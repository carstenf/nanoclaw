import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import { makeVoiceDeleteCalendarEntry } from './voice-delete-calendar-entry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcal-delete-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-calendar.jsonl');

function makeCalendarClient(
  listItems: object[] = [],
  deleteImpl: () => unknown = () => ({}),
) {
  const listMock = vi.fn().mockResolvedValue({ data: { items: listItems } });
  const deleteMock = vi.fn().mockImplementation(deleteImpl);
  const client = { events: { list: listMock, delete: deleteMock } };
  return { client, listMock, deleteMock };
}

describe('makeVoiceDeleteCalendarEntry (REQ-TOOLS-11)', () => {
  it('happy path with event_id: deletes directly, no list call', async () => {
    const { client, listMock, deleteMock } = makeCalendarClient();
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'del-1',
      event_id: 'evt-123',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { deleted: true, event_id: 'evt-123' },
    });
    expect(listMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'primary', eventId: 'evt-123' }),
      expect.anything(),
    );
  });

  it('happy path with title+date: lists, finds match, deletes', async () => {
    const { client, listMock, deleteMock } = makeCalendarClient([
      {
        id: 'evt-found',
        summary: 'Joggen gehen',
        start: { dateTime: '2026-04-20T16:00:00+02:00' },
        end: { dateTime: '2026-04-20T17:00:00+02:00' },
      },
    ]);
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'del-2',
      title: 'Joggen gehen',
      date: '2026-04-20',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { deleted: true, event_id: 'evt-found' },
    });
    expect(listMock).toHaveBeenCalledOnce();
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-found' }),
      expect.anything(),
    );
  });

  it('case-insensitive title match', async () => {
    const { client, deleteMock } = makeCalendarClient([
      {
        id: 'evt-X',
        summary: 'Joggen Gehen',
        start: { dateTime: '2026-04-20T16:00:00+02:00' },
        end: { dateTime: '2026-04-20T17:00:00+02:00' },
      },
    ]);
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      title: 'joggen gehen',
      date: '2026-04-20',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { deleted: true, event_id: 'evt-X' },
    });
    expect(deleteMock).toHaveBeenCalledOnce();
  });

  it('title+date with no match returns ok:false not_found', async () => {
    const { client, deleteMock } = makeCalendarClient([]);
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      title: 'Phantom Termin',
      date: '2026-04-20',
    });

    expect(result).toMatchObject({ ok: false, error: 'not_found' });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('idempotent: 404 from gcal → deleted:true, was_already_deleted:true', async () => {
    const { client } = makeCalendarClient([], () => {
      const err = new Error('Not Found') as Error & { code: number };
      err.code = 404;
      throw err;
    });
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({ event_id: 'gone-already' });

    expect(result).toMatchObject({
      ok: true,
      result: { deleted: true, event_id: 'gone-already', was_already_deleted: true },
    });
  });

  it('410 Gone is also treated as already-deleted', async () => {
    const { client } = makeCalendarClient([], () => {
      const err = new Error('Gone') as Error & { status: number };
      err.status = 410;
      throw err;
    });
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({ event_id: 'gone-410' });
    expect(result).toMatchObject({
      ok: true,
      result: { deleted: true, was_already_deleted: true },
    });
  });

  it('zod rejects: neither event_id nor (title+date)', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(handler({})).rejects.toThrow(BadRequestError);
    await expect(handler({ title: 'only-title' })).rejects.toThrow(
      BadRequestError,
    );
    await expect(handler({ date: '2026-04-20' })).rejects.toThrow(
      BadRequestError,
    );
  });

  it('zod rejects: invalid date format', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ title: 'X', date: '20.04.2026' }),
    ).rejects.toThrow(BadRequestError);
  });

  it('JSONL: calendar_delete_done logged with deleted flag, no PII summary', async () => {
    const { client } = makeCalendarClient([
      {
        id: 'evt-pii',
        summary: 'Secret Termin',
        start: { dateTime: '2026-04-20T16:00:00+02:00' },
        end: { dateTime: '2026-04-20T17:00:00+02:00' },
      },
    ]);
    const jsonlPath = JSONL_PATH();
    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath,
    });

    await handler({
      call_id: 'pii-test',
      title: 'Secret Termin',
      date: '2026-04-20',
    });

    const lines = fs
      .readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    expect(last.event).toBe('calendar_delete_done');
    expect(last.tool).toBe('voice.delete_calendar_entry');
    expect(last.deleted).toBe(true);
    expect(last.event_id).toBe('evt-pii');
    // PII: summary text not in JSONL
    expect(JSON.stringify(last)).not.toContain('Secret Termin');
  });

  it('timeout on list returns gcal_timeout', async () => {
    const listMock = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        }),
    );
    const client = { events: { list: listMock, delete: vi.fn() } };

    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
      timeoutMs: 10,
    });

    const result = await handler({
      title: 'X',
      date: '2026-04-20',
    });
    expect(result).toMatchObject({ ok: false, error: 'gcal_timeout' });
  });

  it('timeout on delete returns gcal_timeout', async () => {
    const deleteMock = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        }),
    );
    const client = { events: { list: vi.fn(), delete: deleteMock } };

    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
      timeoutMs: 10,
    });

    const result = await handler({ event_id: 'evt-slow' });
    expect(result).toMatchObject({ ok: false, error: 'gcal_timeout' });
  });

  it('non-404 error → ok:false internal', async () => {
    const { client } = makeCalendarClient([], () => {
      const err = new Error('Internal Server Error') as Error & {
        code: number;
      };
      err.code = 500;
      throw err;
    });

    const handler = makeVoiceDeleteCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({ event_id: 'evt-500' });
    expect(result).toMatchObject({ ok: false, error: 'internal' });
  });
});
