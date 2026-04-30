import { describe, it, expect, vi } from 'vitest';

import {
  makeVoiceAnalyzeVoicemail,
  parseAnalyzerJson,
} from './voice-analyze-voicemail.js';
import { BadRequestError } from './voice-on-transcript-turn.js';

function makeDeps(
  overrides: Partial<{
    callClaude: (sys: string, msgs: Array<{ role: 'user'; content: string }>) => Promise<string>;
    jsonlPath: string;
    now: () => number;
  }> = {},
) {
  return {
    callClaude:
      overrides.callClaude ??
      (async () =>
        '{"closed_until_iso":"2026-04-30T15:00:00+02:00","closed_today":false,"raw":"ab fuenfzehn Uhr"}'),
    jsonlPath: overrides.jsonlPath ?? '/tmp/test-voice-analyze-voicemail.jsonl',
    now: overrides.now ?? (() => 1777000000000),
  };
}

describe('parseAnalyzerJson', () => {
  it('parses a clean JSON object with all three fields', () => {
    const r = parseAnalyzerJson(
      '{"closed_until_iso":"2026-04-30T15:00:00+02:00","closed_today":false,"raw":"ab 15 Uhr"}',
    );
    expect(r.closed_until_iso).toBe('2026-04-30T15:00:00+02:00');
    expect(r.closed_today).toBe(false);
    expect(r.raw).toBe('ab 15 Uhr');
    expect(r.parseOk).toBe(true);
  });

  it('returns safe defaults on unparseable text', () => {
    const r = parseAnalyzerJson('not even close to JSON');
    expect(r.closed_until_iso).toBeNull();
    expect(r.closed_today).toBe(false);
    expect(r.raw).toBe('');
    expect(r.parseOk).toBe(false);
  });

  it('rejects ISO strings without timezone offset', () => {
    const r = parseAnalyzerJson('{"closed_until_iso":"2026-04-30T15:00:00","closed_today":true,"raw":""}');
    expect(r.closed_until_iso).toBeNull();
    expect(r.closed_today).toBe(true);
  });

  it('extracts a JSON object embedded in surrounding prose', () => {
    const r = parseAnalyzerJson(
      'Here is the result:\n{"closed_until_iso":null,"closed_today":true,"raw":"heute zu"}\nThanks.',
    );
    expect(r.closed_until_iso).toBeNull();
    expect(r.closed_today).toBe(true);
    expect(r.raw).toBe('heute zu');
  });

  it('truncates raw to 200 chars', () => {
    const long = 'x'.repeat(500);
    const r = parseAnalyzerJson(`{"closed_until_iso":null,"closed_today":false,"raw":"${long}"}`);
    expect(r.raw.length).toBe(200);
  });
});

describe('voice_analyze_voicemail', () => {
  it('happy path: claude returns parseable JSON → typed result envelope', async () => {
    const deps = makeDeps();
    const handler = makeVoiceAnalyzeVoicemail(deps);
    const out = (await handler({
      call_id: 'rtc_test',
      transcript: 'Hallo, hier ist die Mailbox. Wir sind ab fuenfzehn Uhr wieder erreichbar.',
      lang: 'de',
    })) as {
      ok: boolean;
      result: { closed_until_iso: string | null; closed_today: boolean; raw: string };
    };
    expect(out.ok).toBe(true);
    expect(out.result.closed_until_iso).toBe('2026-04-30T15:00:00+02:00');
    expect(out.result.closed_today).toBe(false);
    expect(out.result.raw).toBe('ab fuenfzehn Uhr');
  });

  it('lang defaults to "de" when omitted', async () => {
    const callClaude = vi.fn(async () =>
      '{"closed_until_iso":null,"closed_today":false,"raw":""}',
    );
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callClaude }));
    await handler({
      transcript: 'Hallo, hier ist die Mailbox.',
    });
    const sysPrompt = callClaude.mock.calls[0]?.[0] ?? '';
    expect(sysPrompt).toMatch(/Mailbox|Anrufbeantworter/);
  });

  it('passes lang=en to a different system prompt', async () => {
    const callClaude = vi.fn(async () =>
      '{"closed_until_iso":null,"closed_today":false,"raw":""}',
    );
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callClaude }));
    await handler({
      transcript: 'Hello, this is voicemail.',
      lang: 'en',
    });
    const sysPrompt = callClaude.mock.calls[0]?.[0] ?? '';
    expect(sysPrompt).toMatch(/voicemail|answering machine/i);
    expect(sysPrompt).not.toMatch(/Anrufbeantworter/);
  });

  it('claude failure → ok:false envelope, no throw', async () => {
    const callClaude = vi.fn(async () => {
      throw new Error('claude_timeout');
    });
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callClaude }));
    const out = (await handler({
      transcript: 'Mailbox-Ansage hier.',
      lang: 'de',
    })) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toBe('claude_error');
  });

  it('unparseable model output → ok:true with safe defaults (parse_ok=false in jsonl)', async () => {
    const callClaude = vi.fn(async () => 'not JSON at all');
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callClaude }));
    const out = (await handler({
      transcript: 'Hallo, Mailbox.',
      lang: 'de',
    })) as { ok: boolean; result: { closed_until_iso: string | null; closed_today: boolean; raw: string } };
    expect(out.ok).toBe(true);
    expect(out.result.closed_until_iso).toBeNull();
    expect(out.result.closed_today).toBe(false);
    expect(out.result.raw).toBe('');
  });

  it('throws BadRequestError on empty transcript', async () => {
    const handler = makeVoiceAnalyzeVoicemail(makeDeps());
    await expect(handler({ transcript: '' })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it('throws BadRequestError on unsupported lang', async () => {
    const handler = makeVoiceAnalyzeVoicemail(makeDeps());
    await expect(
      handler({ transcript: 'Hallo', lang: 'fr' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
