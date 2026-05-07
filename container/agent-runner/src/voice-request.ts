// container/agent-runner/src/voice-request.ts
//
// Voice-channel IPC envelope handling. Three responsibilities:
//
//  1. parseVoiceRequest — when drainIpcInput sees `{ type: 'voice_request' }`,
//     promote the envelope to a prompt-string and remember the call_id.
//  2. buildVoiceRequestPrompt — wrap the user's request in a system-style
//     header that tells Andy to optimize for voice (max 3 sentences, plain
//     text, no markdown, etc.).
//  3. takePendingVoiceRequest — single-use accessor; the result-emit path
//     calls this on every turn. If a pending call_id exists, the result is
//     tagged with status:'voice_response' instead of status:'success' so
//     the host routes via VoiceRespondManager instead of Discord.
//
// Extracted from container/agent-runner/src/index.ts on 2026-05-07
// (refactor 4 of /add-voice-channel skill extraction). Lives behind a
// stable interface so the agent-runner main loop has only thin
// integration points (one if-branch in drainIpcInput, one call in the
// result emit path).

let _pendingVoiceRequestCallId: string | null = null;

export interface VoiceRequestEnvelope {
  type: 'voice_request';
  call_id: string;
  prompt: string;
}

/**
 * Type-guard for the voice_request IPC envelope. Use in drainIpcInput
 * before promoting to a prompt-string.
 */
export function isVoiceRequestEnvelope(
  data: unknown,
): data is VoiceRequestEnvelope {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === 'voice_request' &&
    typeof d.call_id === 'string' &&
    typeof d.prompt === 'string'
  );
}

/**
 * Promote a voice_request envelope to a wrapped prompt-string. Side effect:
 * stores the call_id so the next assistant result can be tagged with a
 * voice_response output-marker.
 */
export function consumeVoiceRequest(envelope: VoiceRequestEnvelope): string {
  _pendingVoiceRequestCallId = envelope.call_id;
  return buildVoiceRequestPrompt(envelope.call_id, envelope.prompt);
}

/**
 * Single-use accessor for the pending voice request. Returns the call_id
 * (and clears the slot) if a voice_request is pending; null otherwise. The
 * result-emit path calls this on every turn — a non-null return triggers
 * the voice_response marker emit instead of the normal success emit.
 */
export function takePendingVoiceRequest(): string | null {
  const callId = _pendingVoiceRequestCallId;
  _pendingVoiceRequestCallId = null;
  return callId;
}

/**
 * Build the prompt envelope for a voice-channel request. Andy is in the
 * existing whatsapp_main container — the normal output path goes to
 * WhatsApp/Discord. Voice requests must instead route through the
 * voice_respond MCP tool so the bridge gets the result as a tool reply.
 *
 * Hint is appended in plain text (not a system message) because the SDK
 * injects this string into the existing message stream — there is no
 * separate channel for system-level overrides mid-conversation.
 */
function buildVoiceRequestPrompt(callId: string, userRequest: string): string {
  return [
    '############################################################',
    '# VOICE-CHANNEL REQUEST — KRITISCH                          #',
    '############################################################',
    '',
    `call_id: ${callId}`,
    '',
    'Diese Anfrage kommt ueber den Voice-Channel (Telefon).',
    'Operator wartet AM TELEFON auf eine Antwort. Der Voice-Bot wartet bis 90s.',
    '',
    '## DEINE ROLLE',
    '',
    'Du bist Andy in voice-mode. Du hast Zugriff zu allen Tools: WebSearch, WebFetch,',
    'mcp__voice__*, mcp__nanoclaw__*, mcp__gmail__*, mcp__gcalendar__*, Bash, Read, Grep usw.',
    'Optimiere fuer SCHNELLE Antwort. Bei Wetter/Live-Daten: max 1 WebSearch (5-10s).',
    'Wenn du die Antwort schon weisst, antworte direkt ohne Recherche.',
    '',
    '## ANTWORT-PFAD — HARTE REGEL',
    '',
    'Antworte mit PLAIN TEXT als Assistant-message. Diese erste Text-Antwort',
    'in diesem Turn wird automatisch ueber den Voice-Channel an den Operator',
    'vorgelesen — du brauchst KEINEN MCP-Tool-Aufruf dafuer (es gibt KEIN',
    'mcp__nanoclaw__voice_respond, frueherer Hint war veraltet).',
    '',
    'Format:',
    '  - Deutsche Antwort, max 3 Saetze, max 500 Zeichen.',
    '  - KEINE Markdown, KEINE Aufzaehlungen, KEINE Emoji — wird vorgelesen.',
    '  - KEIN <internal>...</internal>-only Output: das wird gestripped und',
    '    laesst voice_short leer (Operator hoert nur "Antwort steht auf',
    '    Discord"-Fallback). Schreibe IMMER einen user-facing Satz.',
    '',
    '## OPTIONAL: discord_long (lange Form mit Quellen/Details)',
    '',
    'Falls du nach der Voice-Antwort noch Details/Quellen auf Discord posten',
    'willst: rufe NACH deiner Voice-Text-Antwort genau einmal',
    'mcp__nanoclaw__send_message mit dem langen Text auf. Das ist optional.',
    '',
    '## VERBOTEN',
    '',
    '- KEIN voice_send_discord_message-Aufruf VOR der Voice-Text-Antwort.',
    '- KEIN JSON-Block oder Tool-call-Wrapper im Text-Output.',
    '- KEIN leerer / nur-<internal>-Output.',
    '',
    '## BEI UNSICHERHEIT',
    '',
    'Antworte mit "Das weiss ich gerade nicht." als Plain-Text. NICHT',
    'halluzinieren. NICHT raten.',
    '',
    '############################################################',
    '# ANFRAGE                                                    #',
    '############################################################',
    '',
    userRequest,
  ].join('\n');
}
