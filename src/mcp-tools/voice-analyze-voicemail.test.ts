import { describe, it, expect, vi } from 'vitest';

import {
  makeVoiceAnalyzeVoicemail,
  parseAnalyzerJson,
} from './voice-analyze-voicemail.js';
import { BadRequestError } from './voice-on-transcript-turn.js';

type AskCoreArgs = { call_id: string; topic: 'andy'; request: string };
type AskCoreFn = (args: AskCoreArgs) => Promise<unknown>;

function makeDeps(
  overrides: Partial<{
    callAskCore: AskCoreFn;
    jsonlPath: string;
    now: () => number;
  }> = {},
) {
  return {
    callAskCore:
      overrides.callAskCore ??
      (async () => ({
        ok: true,
        result: {
          answer:
            '{"closed_until_iso":"2026-04-30T15:00:00+02:00","closed_today":false,"raw":"ab fuenfzehn Uhr"}',
          topic: 'andy' as const,
          citations: [],
        },
      })),
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
    const r = parseAnalyzerJson(
      '{"closed_until_iso":"2026-04-30T15:00:00","closed_today":true,"raw":""}',
    );
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
    const r = parseAnalyzerJson(
      `{"closed_until_iso":null,"closed_today":false,"raw":"${long}"}`,
    );
    expect(r.raw.length).toBe(200);
  });
});

describe('voice_analyze_voicemail', () => {
  it('happy path: ask_core(andy) returns parseable JSON answer → typed result', async () => {
    const deps = makeDeps();
    const handler = makeVoiceAnalyzeVoicemail(deps);
    const out = (await handler({
      call_id: 'rtc_test',
      transcript:
        'Hallo, hier ist die Mailbox. Wir sind ab fuenfzehn Uhr wieder erreichbar.',
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

  it('routes the request via voice_ask_core with topic="andy"', async () => {
    const callAskCore = vi
      .fn<AskCoreFn>()
      .mockResolvedValue({
        ok: true,
        result: {
          answer: '{"closed_until_iso":null,"closed_today":false,"raw":""}',
          topic: 'andy',
          citations: [],
        },
      });
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callAskCore }));
    await handler({
      call_id: 'rtc_x',
      transcript: 'Hallo Mailbox.',
      lang: 'de',
    });
    expect(callAskCore).toHaveBeenCalledTimes(1);
    const args = callAskCore.mock.calls[0]![0];
    expect(args.call_id).toBe('rtc_x');
    expect(args.topic).toBe('andy');
    // The request prompt embeds the transcript verbatim and is lang-specific.
    expect(args.request).toContain('Hallo Mailbox.');
    expect(args.request).toMatch(/Mailbox|Anrufbeantworter/);
  });

  it('lang=en uses English prompt builder; no German tokens in request', async () => {
    const callAskCore = vi
      .fn<AskCoreFn>()
      .mockResolvedValue({
        ok: true,
        result: {
          answer: '{"closed_until_iso":null,"closed_today":false,"raw":""}',
          topic: 'andy',
          citations: [],
        },
      });
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callAskCore }));
    await handler({
      call_id: 'rtc_en',
      transcript: 'Hello, this is voicemail.',
      lang: 'en',
    });
    const req = callAskCore.mock.calls[0]![0].request;
    expect(req).toMatch(/voicemail|answering machine/i);
    expect(req).not.toMatch(/Anrufbeantworter/);
  });

  it('Andy unavailable (callAskCore throws) → ok:false envelope, no throw', async () => {
    const callAskCore = vi.fn<AskCoreFn>().mockRejectedValue(new Error('mcp boom'));
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callAskCore }));
    const out = (await handler({
      call_id: 'rtc_fail',
      transcript: 'Mailbox-Ansage hier.',
      lang: 'de',
    })) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toBe('andy_unavailable');
  });

  it('voice_ask_core ok:false (e.g. Andy not reachable) → ok:false no_answer', async () => {
    const callAskCore = vi
      .fn<AskCoreFn>()
      .mockResolvedValue({ ok: false, error: 'no_active_container' });
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callAskCore }));
    const out = (await handler({
      call_id: 'rtc_q',
      transcript: 'Mailbox.',
      lang: 'de',
    })) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_answer');
  });

  it('Andy answers with non-JSON prose → ok:true with safe defaults', async () => {
    const callAskCore = vi
      .fn<AskCoreFn>()
      .mockResolvedValue({
        ok: true,
        result: {
          answer: 'I could not extract anything specific from that voicemail.',
          topic: 'andy',
          citations: [],
        },
      });
    const handler = makeVoiceAnalyzeVoicemail(makeDeps({ callAskCore }));
    const out = (await handler({
      call_id: 'rtc_z',
      transcript: 'Hallo, Mailbox.',
      lang: 'de',
    })) as {
      ok: boolean;
      result: { closed_until_iso: string | null; closed_today: boolean; raw: string };
    };
    expect(out.ok).toBe(true);
    expect(out.result.closed_until_iso).toBeNull();
    expect(out.result.closed_today).toBe(false);
    expect(out.result.raw).toBe('');
  });

  it('throws BadRequestError on missing call_id', async () => {
    const handler = makeVoiceAnalyzeVoicemail(makeDeps());
    await expect(
      handler({ transcript: 'Hallo.' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws BadRequestError on empty transcript', async () => {
    const handler = makeVoiceAnalyzeVoicemail(makeDeps());
    await expect(
      handler({ call_id: 'rtc_x', transcript: '' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws BadRequestError on unsupported lang', async () => {
    const handler = makeVoiceAnalyzeVoicemail(makeDeps());
    await expect(
      handler({ call_id: 'rtc_x', transcript: 'Hallo', lang: 'fr' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
