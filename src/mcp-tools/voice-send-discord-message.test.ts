import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import { makeVoiceSendDiscordMessage } from './voice-send-discord-message.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdiscord-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-discord.jsonl');
const ALLOWED_CHANNEL = '1490365616518070407';
const ALLOWED_SET = new Set([ALLOWED_CHANNEL]);

function makeOkCallback() {
  return vi.fn().mockResolvedValue({ ok: true as const });
}

describe('makeVoiceSendDiscordMessage', () => {
  it('happy path: delivers message and returns delivered:true', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'smoke-1',
      channel_id: ALLOWED_CHANNEL,
      text: 'Hello from smoke test',
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        delivered: true,
        channel_id: ALLOWED_CHANNEL,
        length: 21,
        chunks: 1,
      },
    });
    expect(cb).toHaveBeenCalledWith(ALLOWED_CHANNEL, 'Hello from smoke test');
  });

  it('allowlist deny: channel_id not in allowlist throws BadRequestError channel_not_allowed', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-2',
        channel_id: '999999999999999999',
        text: 'should be blocked',
      }),
    ).rejects.toThrow(BadRequestError);

    await expect(
      handler({
        call_id: 'smoke-2',
        channel_id: '999999999999999999',
        text: 'should be blocked',
      }),
    ).rejects.toMatchObject({ field: 'channel_id', expected: 'channel_not_allowed' });
  });

  it('snowflake validation: invalid channel_id (not digits) throws BadRequestError', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-3',
        channel_id: 'not-a-snowflake',
        text: 'Hello',
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('empty text throws BadRequestError', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-4',
        channel_id: ALLOWED_CHANNEL,
        text: '',
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('text too long (>4000 chars) throws BadRequestError', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({
        call_id: 'smoke-5',
        channel_id: ALLOWED_CHANNEL,
        text: 'x'.repeat(4001),
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('timeout: callback never resolves → returns ok:false with discord_timeout', async () => {
    const cb = vi.fn().mockImplementation(
      () => new Promise<never>(() => {}), // never resolves
    );
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
      timeoutMs: 20, // very short
    });

    const result = await handler({
      call_id: 'smoke-timeout',
      channel_id: ALLOWED_CHANNEL,
      text: 'Timeout test',
    });

    expect(result).toMatchObject({ ok: false, error: 'discord_timeout' });
  });

  it('JSONL written on success with correct fields (no message text)', async () => {
    const cb = makeOkCallback();
    const jsonlPath = JSONL_PATH();
    const now = vi.fn().mockReturnValue(1000);
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath,
      now,
    });

    await handler({
      call_id: 'smoke-jsonl',
      channel_id: ALLOWED_CHANNEL,
      text: 'PII should not appear',
    });

    const logContent = fs.readFileSync(jsonlPath, 'utf8').trim();
    const entry = JSON.parse(logContent);

    expect(entry.event).toBe('discord_message_sent');
    expect(entry.tool).toBe('voice.send_discord_message');
    expect(entry.call_id).toBe('smoke-jsonl');
    expect(entry.channel_id).toBe(ALLOWED_CHANNEL);
    expect(typeof entry.length).toBe('number');
    expect(entry.chunks).toBe(1);
    expect(typeof entry.latency_ms).toBe('number');

    // PII check: no message text in JSONL
    expect(logContent).not.toContain('PII should not appear');
  });

  it('JSONL written on failure (discord_not_configured) with event discord_message_failed', async () => {
    const cb = vi.fn().mockResolvedValue({ ok: false as const, error: 'discord_not_configured' });
    const jsonlPath = JSONL_PATH();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath,
    });

    const result = await handler({
      call_id: 'smoke-fail',
      channel_id: ALLOWED_CHANNEL,
      text: 'test message',
    });

    expect(result).toMatchObject({ ok: false, error: 'discord_not_configured' });

    const logContent = fs.readFileSync(jsonlPath, 'utf8').trim();
    const entry = JSON.parse(logContent);

    expect(entry.event).toBe('discord_message_failed');
    expect(entry.error).toBe('discord_not_configured');
    expect(entry.call_id).toBe('smoke-fail');
  });
});
