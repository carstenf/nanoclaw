import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeVoiceNotifyUser, TOOL_NAME, VoiceNotifyUserSchema } from './voice-notify-user.js';
import { BadRequestError } from './voice-on-transcript-turn.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWord(n: number): string {
  return Array.from({ length: n }, (_, i) => `Wort${i + 1}`).join(' ');
}

function makeDeps(overrides: Partial<Parameters<typeof makeVoiceNotifyUser>[0]> = {}) {
  const sendWhatsapp = vi.fn().mockResolvedValue({ ok: true });
  const sendDiscord = vi.fn().mockResolvedValue({ ok: true });
  const getActiveChannel = vi.fn().mockReturnValue(null);
  const getMainGroupAndJid = vi.fn().mockReturnValue({ folder: 'main', jid: 'jid@g.us' });
  const isDiscordConnected = vi.fn().mockReturnValue(true);
  const isWhatsappConnected = vi.fn().mockReturnValue(false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-notify-test-'));
  const jsonlPath = path.join(tmpDir, 'voice-notify.jsonl');

  return {
    deps: {
      getActiveChannel,
      sendWhatsappMessage: sendWhatsapp,
      sendDiscordMessage: sendDiscord,
      getMainGroupAndJid,
      isDiscordConnected,
      isWhatsappConnected,
      jsonlPath,
      now: () => 1000,
      ...overrides,
    },
    mocks: { sendWhatsapp, sendDiscord, getActiveChannel, getMainGroupAndJid, isDiscordConnected, isWhatsappConnected },
    jsonlPath,
    tmpDir,
  };
}

function readJsonl(p: string): object[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as object);
}

// ---------------------------------------------------------------------------

describe('voice_notify_user', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: zod rejects missing text
  it('Test 1: zod rejects missing text field', async () => {
    const { deps } = makeDeps();
    const handler = makeVoiceNotifyUser(deps);
    await expect(handler({ urgency: 'info' })).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 2: zod rejects invalid urgency enum
  it('Test 2: zod rejects urgency "urgent" (not in enum)', async () => {
    const { deps } = makeDeps();
    const handler = makeVoiceNotifyUser(deps);
    await expect(handler({ text: 'Hallo', urgency: 'urgent' })).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 3: zod rejects text > 4000 chars
  it('Test 3: zod rejects text.length > 4000', async () => {
    const { deps } = makeDeps();
    const handler = makeVoiceNotifyUser(deps);
    await expect(handler({ text: 'x'.repeat(4001), urgency: 'info' })).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 4: TOOL_NAME matches regex
  it('Test 4: TOOL_NAME matches ^[a-zA-Z0-9_]{1,64}$', () => {
    expect(/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)).toBe(true);
  });

  // Test 5: 10 words + active WhatsApp → routes to WhatsApp
  it('Test 5: 10-word text + active WhatsApp → routes to whatsapp', async () => {
    const text = makeWord(10);
    const { deps, mocks, jsonlPath } = makeDeps({
      getActiveChannel: vi.fn().mockReturnValue('whatsapp'),
      isWhatsappConnected: vi.fn().mockReturnValue(true),
      isDiscordConnected: vi.fn().mockReturnValue(true),
    });
    const handler = makeVoiceNotifyUser(deps);
    const result = await handler({ text, urgency: 'info' }) as { ok: boolean; result?: { routed_via: string; delivered: boolean } };
    expect(result).toEqual({ ok: true, result: { routed_via: 'whatsapp', delivered: true } });
    expect(mocks.sendWhatsapp).toHaveBeenCalledOnce();
    expect(mocks.sendDiscord).not.toHaveBeenCalled();
    const entries = readJsonl(jsonlPath);
    const routeEntry = entries.find((e: any) => e.event === 'voice_notify_user_routed');
    expect(routeEntry).toBeDefined();
    expect((routeEntry as any).routed_via).toBe('whatsapp');
    expect((routeEntry as any).word_count).toBe(10);
  });

  // Test 6: 60 words + active WhatsApp → long_text_override → Discord
  it('Test 6: 60-word text + active WhatsApp → long_text_override → discord', async () => {
    const text = makeWord(60);
    const { deps, mocks, jsonlPath } = makeDeps({
      getActiveChannel: vi.fn().mockReturnValue('whatsapp'),
      isWhatsappConnected: vi.fn().mockReturnValue(true),
      isDiscordConnected: vi.fn().mockReturnValue(true),
    });
    const handler = makeVoiceNotifyUser(deps);
    const result = await handler({ text, urgency: 'info' }) as any;
    expect(result.ok).toBe(true);
    expect(result.result.routed_via).toBe('discord');
    expect(mocks.sendDiscord).toHaveBeenCalledOnce();
    expect(mocks.sendWhatsapp).not.toHaveBeenCalled();
    const entries = readJsonl(jsonlPath);
    const routeEntry = entries.find((e: any) => e.event === 'voice_notify_user_routed') as any;
    expect(routeEntry?.reason).toBe('long_text_override');
  });

  // Test 7: 10 words + NO active WhatsApp + Discord connected → discord fallback
  it('Test 7: 10-word text + no whatsapp + discord connected → discord', async () => {
    const text = makeWord(10);
    const { deps, mocks } = makeDeps({
      getActiveChannel: vi.fn().mockReturnValue(null),
      isWhatsappConnected: vi.fn().mockReturnValue(false),
      isDiscordConnected: vi.fn().mockReturnValue(true),
    });
    const handler = makeVoiceNotifyUser(deps);
    const result = await handler({ text, urgency: 'info' }) as any;
    expect(result.ok).toBe(true);
    expect(result.result.routed_via).toBe('discord');
    expect(mocks.sendDiscord).toHaveBeenCalledOnce();
    expect(mocks.sendWhatsapp).not.toHaveBeenCalled();
  });

  // Test 8: 10 words + no whatsapp + discord NOT connected → routing_failed
  it('Test 8: 10-word text + no whatsapp + discord NOT connected → routing_failed', async () => {
    const text = makeWord(10);
    const { deps, jsonlPath } = makeDeps({
      getActiveChannel: vi.fn().mockReturnValue(null),
      isWhatsappConnected: vi.fn().mockReturnValue(false),
      isDiscordConnected: vi.fn().mockReturnValue(false),
    });
    const handler = makeVoiceNotifyUser(deps);
    const result = await handler({ text, urgency: 'info' }) as any;
    expect(result).toEqual({ ok: false, error: 'routing_failed' });
    const entries = readJsonl(jsonlPath);
    const routeEntry = entries.find((e: any) => e.event === 'voice_notify_user_routed') as any;
    expect(routeEntry?.delivered).toBe(false);
  });

  // Test 9: urgency=alert + Discord succeeds → JSONL has urgency: 'alert'
  it('Test 9: urgency=alert logged in JSONL', async () => {
    const text = makeWord(10);
    const { deps, jsonlPath } = makeDeps({
      getActiveChannel: vi.fn().mockReturnValue(null),
      isDiscordConnected: vi.fn().mockReturnValue(true),
    });
    const handler = makeVoiceNotifyUser(deps);
    await handler({ text, urgency: 'alert' });
    const entries = readJsonl(jsonlPath);
    const routeEntry = entries.find((e: any) => e.event === 'voice_notify_user_routed') as any;
    expect(routeEntry?.urgency).toBe('alert');
  });

  // Test 10: no main group → no_main_group error
  it('Test 10: no main group → returns {ok:false, error:"no_main_group"}', async () => {
    const { deps } = makeDeps({
      getMainGroupAndJid: vi.fn().mockReturnValue(null),
    });
    const handler = makeVoiceNotifyUser(deps);
    const result = await handler({ text: 'Hallo', urgency: 'info' }) as any;
    expect(result).toEqual({ ok: false, error: 'no_main_group' });
  });
});
