import crypto from 'crypto';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { renderVoiceInstructions } from './voice-instructions.js';

const env = readEnvFile([
  'OPENAI_REALTIME_VOICE',
  'OPENAI_PROJECT_ID',
  'VOICE_SIDECAR_URL',
]);

const DEFAULT_VOICE = env.OPENAI_REALTIME_VOICE || 'shimmer';
const PROJECT_ID = env.OPENAI_PROJECT_ID || '';
const SIDECAR_URL = env.VOICE_SIDECAR_URL || 'http://10.0.0.1:4500';

let sidecarReady = false;

// --- Sidecar HTTP client ---

async function sidecarApi(cmd: string): Promise<string> {
  const resp = await fetch(`${SIDECAR_URL}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
  if (!resp.ok) {
    throw new Error(`Sidecar API ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { result?: string };
  return data.result || '';
}

async function sidecarHangup(uuid: string): Promise<void> {
  const resp = await fetch(`${SIDECAR_URL}/call/${uuid}/hangup`, {
    method: 'POST',
  });
  if (!resp.ok) {
    logger.warn({ uuid, status: resp.status }, 'FS: Sidecar hangup failed');
  }
}

async function checkSidecarHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await resp.json()) as { ok: boolean; esl: string };
    return data.ok && data.esl === 'ready';
  } catch {
    return false;
  }
}

/** Cap transcript to prevent memory growth on very long calls */
const MAX_TRANSCRIPT_TURNS = 200;

// --- Call state ---

interface FSCallState {
  callId: string;
  fsUuid: string;
  openaiCallId: string | null;
  goal: string;
  chatJid: string;
  direction: 'inbound' | 'outbound';
  voice: string;
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
  timers: ReturnType<typeof setTimeout>[];
  recordingFile: string;
  to: string;
}

const activeCalls = new Map<string, FSCallState>();

export const pendingFSWebhook = new Map<
  string,
  {
    state: FSCallState;
    resolve: () => void;
    reject: (err: Error) => void;
  }
>();

export interface FreeswitchVoiceDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getMainJid: () => string | undefined;
}

let voiceDeps: FreeswitchVoiceDeps | null = null;

// --- Sidecar-delegated OpenAI session handling ---

export async function acceptOpenAICallForOutbound(
  openaiCallId: string,
  state: FSCallState,
): Promise<void> {
  return acceptViaSidecar(openaiCallId, state);
}

async function acceptViaSidecar(
  openaiCallId: string,
  state: FSCallState,
): Promise<void> {
  const instructions = renderVoiceInstructions({
    direction: state.direction,
    group: 'main',
    goal: state.goal,
  });

  const resp = await fetch(`${SIDECAR_URL}/openai/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      openaiCallId,
      callId: state.callId,
      direction: state.direction,
      instructions,
      voice: state.voice,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Sidecar accept failed (${resp.status}): ${body}`);
  }

  logger.info(
    { callId: state.callId, openaiCallId },
    'FS: Call accepted via sidecar',
  );

  connectSidecarCallSse(state);
}

function connectSidecarCallSse(state: FSCallState): void {
  const url = `${SIDECAR_URL}/openai/events/${encodeURIComponent(state.callId)}`;
  logger.info({ callId: state.callId, url }, 'FS: Connecting sidecar call SSE');

  fetch(url)
    .then(async (resp) => {
      if (!resp.ok || !resp.body) {
        logger.error(
          { callId: state.callId, status: resp.status },
          'FS: Sidecar call SSE failed',
        );
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processChunk = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          logger.info(
            { callId: state.callId },
            'FS: Sidecar call SSE stream ended',
          );
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            handleSidecarCallEvent(state, evt);
          } catch {
            // skip malformed lines
          }
        }

        return processChunk();
      };

      processChunk().catch((err) => {
        logger.error(
          { callId: state.callId, err: err?.message },
          'FS: Sidecar call SSE read error',
        );
      });
    })
    .catch((err) => {
      logger.error(
        { callId: state.callId, err: err?.message },
        'FS: Sidecar call SSE connection error',
      );
    });
}

function handleSidecarCallEvent(
  state: FSCallState,
  evt: Record<string, unknown>,
): void {
  switch (evt.type) {
    case 'transcript': {
      const role = evt.role as 'user' | 'assistant';
      const text = (evt.text as string) || '';
      if (text && state.transcript.length < MAX_TRANSCRIPT_TURNS) {
        state.transcript.push({ role, text });
        const label = role === 'user' ? 'Caller said' : 'Andy said';
        logger.info({ callId: state.callId, text }, `FS: ${label}`);
      }
      break;
    }
    case 'end_call':
      logger.info(
        { callId: state.callId, reason: evt.reason },
        'FS: end_call from sidecar',
      );
      break;
    case 'hangup_ready':
      logger.info(
        { callId: state.callId },
        'FS: hangup_ready from sidecar — cleaning up',
      );
      cleanupCall(state.callId);
      break;
    case 'ws_closed':
      logger.info(
        { callId: state.callId },
        'FS: Sidecar WS closed — cleaning up state',
      );
      cleanupCallState(state.callId);
      break;
    case 'whisper_transcript': {
      const text = (evt.text as string) || '';
      if (text && voiceDeps) {
        logger.info(
          { callId: state.callId, transcriptLen: text.length },
          'FS: Whisper transcript from sidecar',
        );
        const chatJid = state.chatJid || 'dc:1490365616518070407';
        voiceDeps
          .sendMessage(chatJid, `📝 Transkript:\n${text}`)
          .catch(() => {});
      }
      break;
    }
    case 'error':
      logger.error(
        { callId: state.callId, message: evt.message },
        'FS: Sidecar OpenAI error',
      );
      break;
  }
}

// --- Call cleanup ---

function cleanupCallState(callId: string): void {
  const state = activeCalls.get(callId);
  if (!state) return;
  activeCalls.delete(callId);

  for (const t of state.timers) clearTimeout(t);
  state.timers.length = 0;

  // Delegate Whisper transcription to sidecar (reads WAV locally)
  if (state.recordingFile) {
    fetch(`${SIDECAR_URL}/openai/transcribe/${encodeURIComponent(callId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recFile: state.recordingFile }),
    }).catch((err) => {
      logger.error(
        { callId, err: err?.message },
        'FS: Sidecar transcribe request failed',
      );
    });
  }

  logger.info({ callId }, 'FS: Call state cleaned up');
}

function cleanupCall(callId: string): void {
  const state = activeCalls.get(callId);
  if (!state) return;

  // Tell sidecar to tear down the OpenAI session
  fetch(`${SIDECAR_URL}/openai/hangup/${encodeURIComponent(callId)}`, {
    method: 'POST',
  }).catch((err: any) => {
    logger.warn(
      { callId, err: err?.message },
      'FS: Sidecar hangup request failed',
    );
  });

  if (state.fsUuid) {
    sidecarHangup(state.fsUuid).catch(() => {});
  }

  cleanupCallState(callId);
}

function buildSummary(state: FSCallState): string {
  const turns = state.transcript
    .map((t) => `${t.role === 'user' ? 'Andere Seite' : 'Andy'}: ${t.text}`)
    .join('\n');
  return `📞 FreeSWITCH-Anruf abgeschlossen.\nZiel: ${state.goal}\n\n${turns || '(Kein Transkript verfügbar)'}`;
}

// --- Outbound calls via Sidecar ---

export async function makeFreeswitchCall(
  to: string,
  goal: string,
  chatJid: string,
  voice?: string,
): Promise<void> {
  const callVoice = voice || DEFAULT_VOICE;
  if (!sidecarReady) throw new Error('Voice sidecar not connected');
  if (!PROJECT_ID) throw new Error('OPENAI_PROJECT_ID not configured');

  const healthy = await checkSidecarHealth();
  if (!healthy) throw new Error('Voice sidecar not healthy');

  const callId = `fs-out-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  logger.info({ callId, to, goal }, 'FS: Initiating outbound call via sidecar');

  if (voiceDeps && chatJid) {
    voiceDeps
      .sendMessage(chatJid, `📞 Rufe ${to} an (FreeSWITCH)...`)
      .catch(() => {});
  }

  const state: FSCallState = {
    callId,
    fsUuid: '',
    openaiCallId: null,
    goal,
    chatJid,
    direction: 'outbound',
    voice: callVoice,
    transcript: [],
    timers: [],
    recordingFile: '',
    to,
  };
  activeCalls.set(callId, state);

  try {
    // PRE-BRIDGE OUTBOUND FLOW
    // 1. Originate FS→OpenAI directly, park the leg
    // 2. Wait for OpenAI webhook → sidecar accepts + opens control WS
    // 3. Originate user via Sipgate, bridge to parked OpenAI leg
    // Result: user hears Andy immediately, no silence wait

    const webhookPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingFSWebhook.delete(callId);
        reject(new Error('OpenAI webhook timeout (15s)'));
      }, 15000);
      pendingFSWebhook.set(callId, {
        state,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });

    const openaiOriginate =
      `{sip_h_X-Nanoclaw-CallId=${callId},` +
      `origination_caller_id_number=+49308687022346,` +
      `origination_caller_id_name=Andy,` +
      `rtp_secure_media=true,` +
      `absolute_codec_string=PCMA}` +
      `sofia/external/sip:${PROJECT_ID}@sip.api.openai.com;transport=tls &park()`;

    logger.info(
      { callId },
      'FS: Pre-bridge step 1 — originating direct to OpenAI',
    );
    const openaiResult = await sidecarApi(`originate ${openaiOriginate}`);
    if (!openaiResult.startsWith('+OK')) {
      pendingFSWebhook.delete(callId);
      throw new Error(`OpenAI originate failed: ${openaiResult}`);
    }
    const openaiUuid = openaiResult.replace('+OK ', '').trim();
    logger.info({ callId, openaiUuid }, 'FS: OpenAI leg established (parked)');

    if (voiceDeps && chatJid) {
      voiceDeps
        .sendMessage(chatJid, '📞 OpenAI bereit, rufe an...')
        .catch(() => {});
    }

    await webhookPromise;
    logger.info(
      { callId, openaiCallId: state.openaiCallId },
      'FS: OpenAI webhook matched + accept done — pre-bridge ready',
    );

    // Sidecar accept blocks until WS is connected, so we can proceed directly
    logger.info(
      { callId, openaiUuid },
      'FS: OpenAI control WS is open — bridge ready, dialing user',
    );

    const userOriginate =
      `{origination_caller_id_number=+49308687022346,` +
      `origination_caller_id_name=Andy,` +
      `hangup_after_bridge=true}` +
      `sofia/gateway/sipgate/${to} &park()`;

    if (voiceDeps && chatJid) {
      voiceDeps
        .sendMessage(chatJid, `📞 Rufe ${to} an (FreeSWITCH, Pre-Bridge)...`)
        .catch(() => {});
    }

    const userResult = await sidecarApi(`originate ${userOriginate}`);
    if (!userResult.startsWith('+OK')) {
      await sidecarApi(`uuid_kill ${openaiUuid}`).catch(() => {});
      throw new Error(`User originate failed: ${userResult}`);
    }
    const userUuid = userResult.replace('+OK ', '').trim();
    state.fsUuid = userUuid;
    logger.info(
      { callId, userUuid, openaiUuid },
      'FS: User answered (parked), bridging to OpenAI leg',
    );

    const bridgeResult = await sidecarApi(
      `uuid_bridge ${userUuid} ${openaiUuid}`,
    );
    if (!bridgeResult.startsWith('+OK')) {
      logger.warn(
        { callId, bridgeResult },
        'FS: uuid_bridge failed, hanging up legs',
      );
      await sidecarApi(`uuid_kill ${userUuid}`).catch(() => {});
      await sidecarApi(`uuid_kill ${openaiUuid}`).catch(() => {});
      throw new Error(`uuid_bridge failed: ${bridgeResult}`);
    }
    logger.info(
      { callId, userUuid, openaiUuid },
      'FS: uuid_bridge OK — audio flowing user ↔ OpenAI',
    );

    const recFile = `/recordings/${callId}.wav`;
    state.recordingFile = recFile;
    await sidecarApi(`uuid_record ${userUuid} start ${recFile}`);
    logger.info(
      { callId, userUuid, openaiUuid, recFile },
      'FS: User-leg established and bridged to OpenAI, recording started',
    );

    await sidecarApi(`uuid_setvar ${userUuid} nanoclaw_call_id ${callId}`);
  } catch (err: any) {
    logger.error({ callId, err: err?.message }, 'FS: Outbound call failed');
    if (voiceDeps && chatJid) {
      voiceDeps
        .sendMessage(chatJid, `📞 Anruf fehlgeschlagen: ${err?.message}`)
        .catch(() => {});
    }
    cleanupCall(callId);
  }
}

// --- Inbound call handler (webhook-triggered) ---

export function handleFSInboundWebhook(openaiCallId: string): void {
  const callId = `fs-in-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
  logger.info(
    { callId, openaiCallId },
    'FS: Handling inbound call via webhook',
  );

  const state: FSCallState = {
    callId,
    fsUuid: '',
    openaiCallId,
    goal: 'Incoming call — answer and help the caller',
    chatJid: '',
    direction: 'inbound',
    voice: DEFAULT_VOICE,
    transcript: [],
    timers: [],
    recordingFile: 'inbound',
    to: '',
  };

  if (voiceDeps) {
    const mainJid = voiceDeps.getMainJid();
    state.chatJid = mainJid || 'dc:1490365616518070407';
  }

  activeCalls.set(callId, state);

  acceptViaSidecar(openaiCallId, state).catch((err) => {
    logger.error({ callId, err: err?.message }, 'FS: Inbound accept failed');
    cleanupCall(callId);
  });
}

// --- SSE event stream from sidecar (channel lifecycle) ---

function connectSidecarSse(): void {
  if (!sidecarReady) return;
  const url = `${SIDECAR_URL}/events`;
  logger.info({ url }, 'FS: Sidecar healthy, connecting SSE');

  fetch(url)
    .then(async (resp) => {
      if (!resp.ok || !resp.body) {
        logger.error(
          { status: resp.status },
          'FS: Sidecar SSE connection failed',
        );
        scheduleSseReconnect();
        return;
      }

      logger.info('FS: SSE stream connected');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processChunk = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          logger.info('FS: SSE stream ended, reconnecting...');
          scheduleSseReconnect();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6)) as {
              event: string;
              uuid?: string;
              hangupCause?: string;
            };
            if (
              evt.event === 'CHANNEL_HANGUP_COMPLETE' ||
              evt.event === 'CHANNEL_HANGUP'
            ) {
              handleChannelHangup(evt.uuid, evt.hangupCause);
            }
          } catch {
            // skip malformed SSE lines
          }
        }

        return processChunk();
      };

      processChunk().catch((err) => {
        logger.error(
          { err: err?.message },
          'FS: SSE read error, reconnecting...',
        );
        scheduleSseReconnect();
      });
    })
    .catch((err) => {
      logger.error(
        { err: err?.message },
        'FS: SSE connection error, reconnecting...',
      );
      scheduleSseReconnect();
    });
}

function scheduleSseReconnect(): void {
  setTimeout(() => {
    checkSidecarHealth().then((ok) => {
      if (ok) {
        sidecarReady = true;
        connectSidecarSse();
      } else {
        scheduleSseReconnect();
      }
    });
  }, 5000);
}

function handleChannelHangup(
  uuid: string | undefined,
  cause: string | undefined,
): void {
  if (!uuid) return;
  for (const [callId, state] of activeCalls) {
    if (state.fsUuid === uuid) {
      logger.info(
        { callId, cause },
        'FS: Channel hangup via SSE',
      );
      cleanupCall(callId);
      return;
    }
  }
}

// --- Init ---

export function initFreeswitchVoice(deps: FreeswitchVoiceDeps): void {
  voiceDeps = deps;

  checkSidecarHealth().then((ok) => {
    sidecarReady = ok;
    if (ok) {
      logger.info(
        { sidecar: SIDECAR_URL },
        'FS: FreeSWITCH voice initialized via sidecar (webhook via openai-webhook on 4402)',
      );
      connectSidecarSse();
    } else {
      logger.warn(
        { sidecar: SIDECAR_URL },
        'FS: Sidecar not healthy at startup, will retry...',
      );
      scheduleSseReconnect();
    }
  });
}
