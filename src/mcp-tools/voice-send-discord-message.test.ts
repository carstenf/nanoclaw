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

describe('makeVoiceSendDiscordMessage (REQ-TOOLS-03)', () => {
  it('happy path: delivers message via {channel, content} args and returns {ok:true}', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    const result = await handler({
      call_id: 'smoke-1',
      channel: ALLOWED_CHANNEL,
      content: 'Hello from smoke test',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { ok: true },
    });
    expect(cb).toHaveBeenCalledWith(ALLOWED_CHANNEL, 'Hello from smoke test');
  });

  it('dedup: second call with same channel+content within 5min → ok:true, no Discord send', async () => {
    const cb = makeOkCallback();
    let fakeNow = 1000;
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
      now: () => fakeNow,
      dedupTtlMs: 300000, // 5 min
    });

    // First call — should send
    await handler({ channel: ALLOWED_CHANNEL, content: 'dedup test content' });
    expect(cb).toHaveBeenCalledTimes(1);

    // Second call within TTL — should NOT send
    fakeNow = 2000;
    const result2 = (await handler({
      channel: ALLOWED_CHANNEL,
      content: 'dedup test content',
    })) as { ok: true; result: { ok: boolean } };
    expect(result2.ok).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it('dedup expired: same content after TTL → re-sends', async () => {
    const cb = makeOkCallback();
    let fakeNow = 1000;
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
      now: () => fakeNow,
      dedupTtlMs: 5000, // 5s TTL for test
    });

    await handler({ channel: ALLOWED_CHANNEL, content: 'expire test' });
    expect(cb).toHaveBeenCalledTimes(1);

    // Advance past TTL
    fakeNow = 1000 + 6000;
    await handler({ channel: ALLOWED_CHANNEL, content: 'expire test' });
    expect(cb).toHaveBeenCalledTimes(2); // re-sent
  });

  it('channel_not_allowed → throws BadRequestError', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ channel: '999999999999999999', content: 'blocked' }),
    ).rejects.toMatchObject({
      field: 'channel',
      expected: 'channel_not_allowed',
    });
  });

  it('invalid snowflake → throws BadRequestError', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ channel: 'not-a-snowflake', content: 'test' }),
    ).rejects.toThrow(BadRequestError);
  });

  it('content empty → throws BadRequestError', async () => {
    const cb = makeOkCallback();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath: JSONL_PATH(),
    });

    await expect(
      handler({ channel: ALLOWED_CHANNEL, content: '' }),
    ).rejects.toThrow(BadRequestError);
  });

  it('JSONL: discord_message_sent with content_hash, no message text (PII-clean)', async () => {
    const cb = makeOkCallback();
    const jsonlPath = JSONL_PATH();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath,
      now: vi.fn().mockReturnValue(1000),
    });

    await handler({
      call_id: 'pii-test',
      channel: ALLOWED_CHANNEL,
      content: 'PII should not appear in logs',
    });

    const logContent = fs.readFileSync(jsonlPath, 'utf8').trim();
    const entry = JSON.parse(logContent.split('\n')[0]);

    expect(entry.event).toBe('discord_message_sent');
    expect(entry.tool).toBe('voice_send_discord_message');
    expect(entry.call_id).toBe('pii-test');
    expect(typeof entry.content_hash).toBe('string');
    expect(entry.content_hash.length).toBe(8); // first 8 hex chars
    expect(typeof entry.latency_ms).toBe('number');
    // PII check
    expect(logContent).not.toContain('PII should not appear');
  });

  it('dedup: JSONL contains discord_message_deduplicated event on second call', async () => {
    const cb = makeOkCallback();
    let fakeNow = 1000;
    const jsonlPath = JSONL_PATH();
    const handler = makeVoiceSendDiscordMessage({
      sendDiscordMessage: cb,
      allowedChannels: ALLOWED_SET,
      jsonlPath,
      now: () => fakeNow,
      dedupTtlMs: 300000,
    });

    await handler({
      call_id: 'first',
      channel: ALLOWED_CHANNEL,
      content: 'dedup-log-test',
    });
    fakeNow = 2000;
    await handler({
      call_id: 'second',
      channel: ALLOWED_CHANNEL,
      content: 'dedup-log-test',
    });

    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toContain('discord_message_deduplicated');
  });
});
