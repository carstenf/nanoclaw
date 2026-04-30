// src/mcp-tools/voice-analyze-voicemail.ts
// open_points 2026-04-29: voice_analyze_voicemail — extract opening info from
// a captured voicemail greeting transcript so the bridge can schedule a smart
// retry instead of the blind 5/15/45/120 ladder.
//
// Wraps callClaudeViaOneCli with a tight extraction prompt. The model is
// instructed to return ONE JSON object with three fields:
//   - closed_until_iso?: string   // ISO-8601 with TZ; next opening time
//   - closed_today?: boolean      // greeting says shut for the rest of today
//   - raw: string                 // model's quote of the relevant phrase
//
// Lang-aware (de | en | it). Falls back to {raw: <transcript>} when the model
// returns unparseable JSON or the transcript is too short — caller treats
// "no actionable info" as "use ladder".
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR, SLOW_BRAIN_CLAUDE_TIMEOUT_MS } from '../config.js';
import { logger } from '../logger.js';

import { callClaudeViaOneCli } from './claude-client.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_analyze_voicemail' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

export const VoiceAnalyzeVoicemailSchema = z.object({
  call_id: z.string().optional(),
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
  /** Sonnet caller — defaults to callClaudeViaOneCli, override for tests. */
  callClaude?: typeof callClaudeViaOneCli;
  /** Timeout in ms. Default SLOW_BRAIN_CLAUDE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** JSONL audit path. Default DATA_DIR/voice-analyze-voicemail.jsonl. */
  jsonlPath?: string;
  /** Now for reference_iso default + JSONL ts. Injectable for tests. */
  now?: () => number;
}

const SYSTEM_PROMPT_BY_LANG: Record<'de' | 'en' | 'it', string> = {
  de: `Du analysierst die Ansage einer Mailbox/Anrufbeantworter. Extrahiere wenn moeglich, ab wann der Counterpart wieder erreichbar ist.

Ausgabe: GENAU ein JSON-Objekt, ohne Markdown, ohne Erklaerung. Felder:
- closed_until_iso: ISO-8601 mit Zeitzone (z.B. "2026-04-30T15:00:00+02:00") wenn die Ansage eine konkrete Wieder-Erreichbarkeit nennt; sonst null
- closed_today: true wenn die Ansage sagt dass heute nicht mehr erreichbar (egal ob mit oder ohne konkreter Folge-Zeit), sonst false
- raw: das relevante Originalzitat (max 200 Zeichen) auf das du dich stuetzt; "" wenn keine Info

Regeln:
- relative Zeitangaben ("morgen 9 Uhr", "in einer Stunde", "ab 15 Uhr") gegen die referenzzeit aufloesen
- nur was wirklich gesagt wurde — nicht raten
- bei "ab Montag" + heute Sonntag → naechster Montag 09:00 lokal als Default-Stunde wenn keine Stunde genannt
- bei IVR/Werbung/Standardansage ohne konkrete Info → alle drei Felder leer/false/null/""`,
  en: `You analyze the recording of a voicemail/answering machine. Extract when the counterpart will be reachable again, if stated.

Output: EXACTLY one JSON object, no markdown, no explanation. Fields:
- closed_until_iso: ISO-8601 with timezone (e.g. "2026-04-30T15:00:00+02:00") if the greeting names a specific re-availability; else null
- closed_today: true if the greeting says they're not reachable for the rest of today (with or without concrete next-time), else false
- raw: the relevant original quote (max 200 chars) you're basing it on; "" if no info

Rules:
- resolve relative times ("tomorrow 9 am", "in an hour", "from 3 pm") against the reference time
- only what was actually said — do not guess
- for "from Monday" + today Sunday → next Monday 09:00 local as default hour if none stated
- for IVR/promo/generic greeting without concrete info → all three fields empty/false/null/""`,
  it: `Analizzi una registrazione di segreteria telefonica. Estrai quando il destinatario sara' nuovamente raggiungibile, se indicato.

Output: ESATTAMENTE un oggetto JSON, niente markdown, niente spiegazioni. Campi:
- closed_until_iso: ISO-8601 con timezone (es. "2026-04-30T15:00:00+02:00") se il messaggio indica una riapertura concreta; altrimenti null
- closed_today: true se il messaggio dice che non sono raggiungibili per il resto della giornata, altrimenti false
- raw: la citazione originale rilevante (max 200 caratteri); "" se nessuna informazione

Regole:
- risolvi tempi relativi ("domani alle 9", "fra un'ora", "dalle 15") rispetto al tempo di riferimento
- solo cio' che e' stato detto — non indovinare
- per "da lunedi'" + oggi domenica → lunedi' prossimo 09:00 locale come ora di default se nessuna ora indicata
- per IVR/promo/messaggio generico senza info concreta → tutti i campi vuoti/false/null/""`,
};

export function makeVoiceAnalyzeVoicemail(
  deps: VoiceAnalyzeVoicemailDeps = {},
): ToolHandler {
  const callClaude = deps.callClaude ?? callClaudeViaOneCli;
  const timeoutMs = deps.timeoutMs ?? SLOW_BRAIN_CLAUDE_TIMEOUT_MS;
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
    const systemPrompt = SYSTEM_PROMPT_BY_LANG[langKey];
    const userPrompt = `Reference time: ${refIso}\n\nVoicemail transcript:\n"""\n${transcript}\n"""`;

    let modelText = '';
    try {
      modelText = await callClaude(
        systemPrompt,
        [{ role: 'user', content: userPrompt }],
        { timeoutMs },
      );
    } catch (err) {
      logger.warn({
        event: 'voice_analyze_voicemail_claude_error',
        call_id: call_id ?? null,
        err: (err as Error)?.message,
      });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'voice_analyze_voicemail_failed',
        call_id: call_id ?? null,
        transcript_len: transcript.length,
        lang: langKey,
        elapsed_ms: nowFn() - start,
        error: (err as Error)?.message ?? 'claude_error',
      });
      return { ok: false as const, error: 'claude_error' };
    }

    const parsed = parseAnalyzerJson(modelText);
    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'voice_analyze_voicemail_done',
      call_id: call_id ?? null,
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
 * Strict-but-tolerant JSON extraction: the model is instructed to return one
 * JSON object, but it sometimes wraps it in prose. Find the first {...}
 * block, parse it, validate fields. On any failure return safe defaults so
 * the caller can fall back to the ladder without blowing up.
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

  // closed_until_iso must be a non-empty ISO string with offset/Z; otherwise null.
  let closedUntilIso: string | null = null;
  if (typeof obj.closed_until_iso === 'string' && obj.closed_until_iso.length > 0) {
    const candidateIso = obj.closed_until_iso;
    // Accept Z or ±HH:MM offset. Reject if Date parsing fails.
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(candidateIso) && !Number.isNaN(Date.parse(candidateIso))) {
      closedUntilIso = candidateIso;
    }
  }

  const closedToday = obj.closed_today === true;
  const raw =
    typeof obj.raw === 'string' ? obj.raw.slice(0, 200) : '';

  return {
    closed_until_iso: closedUntilIso,
    closed_today: closedToday,
    raw,
    parseOk: true,
  };
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}
