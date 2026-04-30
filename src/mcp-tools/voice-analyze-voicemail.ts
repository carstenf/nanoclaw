// src/mcp-tools/voice-analyze-voicemail.ts
// open_points 2026-04-29: voice_analyze_voicemail — extract opening info from
// a captured voicemail greeting transcript so the bridge can schedule a smart
// retry instead of the blind 5/15/45/120 ladder.
//
// 2026-04-30 refactor: routes through voice_ask_core(topic='andy') instead of
// calling Sonnet directly via OneCLI. The voice-channel keeps zero direct
// Anthropic dependency — all LLM thinking goes through Andy (the NanoClaw
// container-agent), which uses Claude Max OAuth via the existing IPC path.
// Andy receives a tight extraction prompt and replies with a JSON object;
// parseAnalyzerJson() handles the same tolerant extraction as before.
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_analyze_voicemail' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

export const VoiceAnalyzeVoicemailSchema = z.object({
  // call_id is required because voice_ask_core(topic='andy') injects the
  // request via the per-call VoiceRespondManager — no call_id, no Andy.
  call_id: z.string().min(1),
  transcript: z.string().min(1).max(4000),
  lang: z.enum(['de', 'en', 'it']).optional(),
  /**
   * Caller's local time, ISO-8601. Used by the model to resolve relative
   * phrasings ("ab morgen 9 Uhr") to an absolute timestamp. Defaults to now.
   */
  reference_iso: z.string().datetime({ offset: true }).optional(),
});

export type VoiceAnalyzeVoicemailInput = z.infer<
  typeof VoiceAnalyzeVoicemailSchema
>;

export interface VoiceAnalyzeVoicemailResult {
  closed_until_iso: string | null;
  closed_today: boolean;
  raw: string;
}

export interface VoiceAnalyzeVoicemailDeps {
  /**
   * Invokes voice_ask_core in the registry. The handler always uses
   * topic='andy' so the request hits Andy via the existing-container IPC path
   * (no direct Sonnet call). DI for tests.
   */
  callAskCore: (args: {
    call_id: string;
    topic: 'andy';
    request: string;
  }) => Promise<unknown>;
  /** JSONL audit path. Default DATA_DIR/voice-analyze-voicemail.jsonl. */
  jsonlPath?: string;
  /** Now for reference_iso default + JSONL ts. Injectable for tests. */
  now?: () => number;
}

const PROMPT_BUILDERS: Record<
  'de' | 'en' | 'it',
  (transcript: string, refIso: string) => string
> = {
  de: (transcript, refIso) =>
    `Du analysierst die Ansage einer Mailbox/Anrufbeantworter. Extrahiere wenn moeglich, ab wann der Counterpart wieder erreichbar ist.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne Markdown, ohne Erklaerung. Felder:
- closed_until_iso: ISO-8601 mit Zeitzone (z.B. "2026-04-30T15:00:00+02:00") wenn die Ansage eine konkrete Wieder-Erreichbarkeit nennt; sonst null
- closed_today: true wenn die Ansage sagt dass heute nicht mehr erreichbar (egal ob mit oder ohne konkreter Folge-Zeit), sonst false
- raw: das relevante Originalzitat (max 200 Zeichen) auf das du dich stuetzt; "" wenn keine Info

Regeln:
- relative Zeitangaben ("morgen 9 Uhr", "in einer Stunde", "ab 15 Uhr") gegen die Referenzzeit aufloesen
- nur was wirklich gesagt wurde — nicht raten
- bei "ab Montag" + heute Sonntag → naechster Montag 09:00 lokal als Default-Stunde wenn keine Stunde genannt
- bei IVR/Werbung/Standardansage ohne konkrete Info → alle drei Felder leer/false/null/""

Referenz-Zeit: ${refIso}

Mailbox-Ansage:
"""
${transcript}
"""

Antworte mit dem JSON, sonst nichts.`,
  en: (transcript, refIso) =>
    `You analyze the recording of a voicemail/answering machine. Extract when the counterpart will be reachable again, if stated.

Reply EXCLUSIVELY with one JSON object, no markdown, no explanation. Fields:
- closed_until_iso: ISO-8601 with timezone (e.g. "2026-04-30T15:00:00+02:00") if the greeting names a specific re-availability; else null
- closed_today: true if the greeting says they're not reachable for the rest of today, else false
- raw: the relevant original quote (max 200 chars) you're basing it on; "" if no info

Rules:
- resolve relative times ("tomorrow 9 am", "in an hour", "from 3 pm") against the reference time
- only what was actually said — do not guess
- for "from Monday" + today Sunday → next Monday 09:00 local as default hour if none stated
- for IVR/promo/generic greeting without concrete info → all three fields empty/false/null/""

Reference time: ${refIso}

Voicemail transcript:
"""
${transcript}
"""

Reply with the JSON, nothing else.`,
  it: (transcript, refIso) =>
    `Analizzi una registrazione di segreteria telefonica. Estrai quando il destinatario sara' nuovamente raggiungibile, se indicato.

Rispondi ESCLUSIVAMENTE con un oggetto JSON, niente markdown, niente spiegazioni. Campi:
- closed_until_iso: ISO-8601 con timezone (es. "2026-04-30T15:00:00+02:00") se il messaggio indica una riapertura concreta; altrimenti null
- closed_today: true se il messaggio dice che non sono raggiungibili per il resto della giornata, altrimenti false
- raw: la citazione originale rilevante (max 200 caratteri); "" se nessuna informazione

Regole:
- risolvi tempi relativi ("domani alle 9", "fra un'ora", "dalle 15") rispetto al tempo di riferimento
- solo cio' che e' stato detto — non indovinare
- per "da lunedi'" + oggi domenica → lunedi' prossimo 09:00 locale come ora di default se nessuna ora indicata
- per IVR/promo/messaggio generico senza info concreta → tutti i campi vuoti/false/null/""

Tempo di riferimento: ${refIso}

Messaggio segreteria:
"""
${transcript}
"""

Rispondi con il JSON, nient'altro.`,
};

export function makeVoiceAnalyzeVoicemail(
  deps: VoiceAnalyzeVoicemailDeps,
): ToolHandler {
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-analyze-voicemail.jsonl');
  const nowFn = deps.now ?? (() => Date.now());

  return async function voiceAnalyzeVoicemail(args: unknown) {
    const parseResult = VoiceAnalyzeVoicemailSchema.safeParse(args);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstIssue?.path?.[0] ?? 'input'),
        firstIssue?.message ?? 'invalid',
      );
    }

    const { call_id, transcript, lang, reference_iso } = parseResult.data;
    const langKey: 'de' | 'en' | 'it' = lang ?? 'de';
    const start = nowFn();
    const refIso = reference_iso ?? new Date(start).toISOString();
    const request = PROMPT_BUILDERS[langKey](transcript, refIso);

    let askResponse: unknown;
    try {
      askResponse = await deps.callAskCore({
        call_id,
        topic: 'andy',
        request,
      });
    } catch (err) {
      logger.warn({
        event: 'voice_analyze_voicemail_andy_error',
        call_id,
        err: (err as Error)?.message,
      });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'voice_analyze_voicemail_failed',
        call_id,
        transcript_len: transcript.length,
        lang: langKey,
        elapsed_ms: nowFn() - start,
        error: 'andy_unavailable',
      });
      return { ok: false as const, error: 'andy_unavailable' };
    }

    const answer = extractAnswer(askResponse);
    if (!answer) {
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'voice_analyze_voicemail_failed',
        call_id,
        transcript_len: transcript.length,
        lang: langKey,
        elapsed_ms: nowFn() - start,
        error: 'no_answer',
      });
      return { ok: false as const, error: 'no_answer' };
    }

    const parsed = parseAnalyzerJson(answer);
    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'voice_analyze_voicemail_done',
      call_id,
      transcript_len: transcript.length,
      lang: langKey,
      elapsed_ms: nowFn() - start,
      closed_until_iso: parsed.closed_until_iso,
      closed_today: parsed.closed_today,
      parse_ok: parsed.parseOk,
    });

    const result: VoiceAnalyzeVoicemailResult = {
      closed_until_iso: parsed.closed_until_iso,
      closed_today: parsed.closed_today,
      raw: parsed.raw,
    };
    return { ok: true as const, result };
  };
}

interface ParsedAnalyzer {
  closed_until_iso: string | null;
  closed_today: boolean;
  raw: string;
  parseOk: boolean;
}

/**
 * Strict-but-tolerant JSON extraction: Andy is instructed to return one JSON
 * object, but a chat agent occasionally wraps it in prose. Find the first
 * {...} block, parse it, validate fields. On any failure return safe defaults
 * so the caller can fall back to the ladder without blowing up.
 */
export function parseAnalyzerJson(text: string): ParsedAnalyzer {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { closed_until_iso: null, closed_today: false, raw: '', parseOk: false };
  }
  const candidate = trimmed.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { closed_until_iso: null, closed_today: false, raw: '', parseOk: false };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { closed_until_iso: null, closed_today: false, raw: '', parseOk: false };
  }
  const obj = parsed as Record<string, unknown>;

  let closedUntilIso: string | null = null;
  if (typeof obj.closed_until_iso === 'string' && obj.closed_until_iso.length > 0) {
    const candidateIso = obj.closed_until_iso;
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(candidateIso) && !Number.isNaN(Date.parse(candidateIso))) {
      closedUntilIso = candidateIso;
    }
  }

  const closedToday = obj.closed_today === true;
  const raw = typeof obj.raw === 'string' ? obj.raw.slice(0, 200) : '';

  return {
    closed_until_iso: closedUntilIso,
    closed_today: closedToday,
    raw,
    parseOk: true,
  };
}

/**
 * voice_ask_core returns { ok: true, result: { answer, topic, citations } }
 * on success and { ok: false, error } on failure. This helper extracts the
 * answer string from the success envelope; returns null otherwise.
 */
function extractAnswer(resp: unknown): string | null {
  if (!resp || typeof resp !== 'object') return null;
  const obj = resp as Record<string, unknown>;
  if (obj.ok !== true) return null;
  const result = obj.result;
  if (!result || typeof result !== 'object') return null;
  const ans = (result as Record<string, unknown>).answer;
  return typeof ans === 'string' ? ans : null;
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}
