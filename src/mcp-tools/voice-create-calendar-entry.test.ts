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

function makeCalendarClient(eventId = 'test-event-id', htmlLink = 'https://calendar.google.com/event/test') {
  const insertMock = vi.fn().mockResolvedValue({
    data: { id: eventId, htmlLink },
  });
  const client = { events: { insert: insertMock } };
  return { client, insertMock };
}

describe('makeVoiceCreateCalendarEntry', () => {
  it('happy path: creates event and returns eventId + htmlLink', async () => {
    const { client, insertMock } = makeCalendarClient('evt-created-1', 'https://calendar.google.com/evt-1');

    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'smoke-create-1',
      summary: 'NanoClaw-Smoke 03-03',
      start: '2026-04-17T14:00:00+02:00',
      end: '2026-04-17T15:00:00+02:00',
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        eventId: 'evt-created-1',
        htmlLink: 'https://calendar.google.com/evt-1',
      },
    });

    // events.insert called with correct requestBody shape
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          summary: 'NanoClaw-Smoke 03-03',
          start: expect.objectContaining({ dateTime: '2026-04-17T14:00:00+02:00' }),
          end: expect.objectContaining({ dateTime: '2026-04-17T15:00:00+02:00' }),
        }),
      }),
      expect.anything(),
    );
  });

  it('empty summary throws BadRequestError', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-2',
        summary: '   ', // whitespace-only
        start: '2026-04-17T14:00:00Z',
        end: '2026-04-17T15:00:00Z',
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('end <= start throws BadRequestError', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-3',
        summary: 'Test Event',
        start: '2026-04-17T15:00:00Z',
        end: '2026-04-17T14:00:00Z', // end < start
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('invalid attendee email throws BadRequestError', async () => {
    const { client } = makeCalendarClient();
    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-4',
        summary: 'Test Event',
        start: '2026-04-17T14:00:00Z',
        end: '2026-04-17T15:00:00Z',
        attendees: ['not-an-email'],
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('appends calendar_create_done event to JSONL on success (PII-free)', async () => {
    const { client } = makeCalendarClient('evt-jsonl-test', 'https://cal.test/evt-jsonl');
    const jsonlPath = JSONL_PATH();

    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath,
    });

    await handler({
      call_id: 'smoke-jsonl',
      summary: 'Secret Meeting Title',
      start: '2026-04-17T14:00:00Z',
      end: '2026-04-17T15:00:00Z',
      attendees: ['colleague@example.com'],
    });

    const logContent = fs.readFileSync(jsonlPath, 'utf8').trim();
    const logEntry = JSON.parse(logContent);

    expect(logEntry.event).toBe('calendar_create_done');
    expect(logEntry.call_id).toBe('smoke-jsonl');
    expect(logEntry.tool).toBe('voice.create_calendar_entry');
    expect(typeof logEntry.latency_ms).toBe('number');
    expect(logEntry.event_id).toBe('evt-jsonl-test');
    expect(logEntry.calendar_id).toBe('primary');

    // PII check: no summary, no attendee emails in JSONL
    expect(logContent).not.toContain('Secret Meeting Title');
    expect(logContent).not.toContain('colleague@example.com');
  });

  it('with optional description and location passes them to requestBody', async () => {
    const { client, insertMock } = makeCalendarClient();

    const handler = makeVoiceCreateCalendarEntry({
      calendarClient: vi.fn().mockResolvedValue(client),
      jsonlPath: JSONL_PATH(),
    });

    await handler({
      call_id: 'smoke-optional',
      summary: 'Optional Fields Test',
      start: '2026-04-17T14:00:00Z',
      end: '2026-04-17T15:00:00Z',
      description: 'Some details',
      location: 'Munich',
    });

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          description: 'Some details',
          location: 'Munich',
        }),
      }),
      expect.anything(),
    );
  });
});
