import crypto from 'crypto';
import OpenAI from 'openai';
import { WebSocket } from 'ws';
// @ts-ignore — no type declarations for modesl
import esl from 'modesl';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile([
  'OPENAI_SIP_API_KEY',
  'HINDSIGHT_LLM_API_KEY',
  'OPENAI_REALTIME_VOICE',
  'OPENAI_PROJECT_ID',
  'FREESWITCH_ESL_HOST',
  'FREESWITCH_ESL_PORT',
  'FREESWITCH_ESL_PASSWORD',
]);

const OPENAI_API_KEY =
  env.OPENAI_SIP_API_KEY || env.HINDSIGHT_LLM_API_KEY || '';
const DEFAULT_VOICE = env.OPENAI_REALTIME_VOICE || 'shimmer';
const PROJECT_ID = env.OPENAI_PROJECT_ID || '';
const ESL_HOST = env.FREESWITCH_ESL_HOST || '10.0.0.1';
const ESL_PORT = parseInt(env.FREESWITCH_ESL_PORT || '8021', 10);
const ESL_PASSWORD = env.FREESWITCH_ESL_PASSWORD || 'ClueCon';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let eslConn: any = null;

/** Cap transcript to prevent memory growth on very long calls */
const MAX_TRANSCRIPT_TURNS = 200;

// --- Call state ---

interface FSCallState {
  callId: string;
  fsUuid: string; // FreeSWITCH channel UUID
  openaiCallId: string | null;
  goal: string;
  chatJid: string;
  direction: 'inbound' | 'outbound';
  voice: string;
  controlWs: WebSocket | null;
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Pending timers that should be cleared on cleanup */
  timers: ReturnType<typeof setTimeout>[];
}

const activeCalls = new Map<string, FSCallState>();

// Exported so openai-webhook handler can match incoming webhooks to pending outbound calls
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

// --- OpenAI call accept + control WebSocket ---

async function acceptOpenAICall(
  openaiCallId: string,
  state: FSCallState,
): Promise<void> {
  logger.info(
    { callId: state.callId, openaiCallId, goal: state.goal },
    'FS: Accepting call via OpenAI Realtime API',
  );

  try {
    const instructions =
      state.direction === 'outbound'
        ? `You are Andy, a personal assistant for Carsten (Munich, Germany).
You are making an outbound phone call. Your goal: ${state.goal}
Speak German by default. Be friendly and professional.
If the other person speaks another language, switch to that language.
Keep responses short and natural.`
        : `You are Andy, a personal assistant. You answer incoming phone calls for Carsten (Munich, Germany).
Speak German by default. Be friendly and helpful. Say "Hallo, hier ist Andy, wie kann ich helfen?" when the call starts.
If the caller speaks another language, switch to that language.
Keep responses short and natural.`;

    await openai.realtime.calls.accept(openaiCallId, {
      type: 'realtime',
      model: 'gpt-4o-realtime-preview',
      instructions,
      audio: {
        output: { voice: state.voice },
      },
    } as any);

    logger.info({ callId: state.callId, openaiCallId }, 'FS: Call accepted');
    connectControlWs(openaiCallId, state);
  } catch (err: any) {
    logger.error(
      { callId: state.callId, err: err?.message },
      'FS: Failed to accept OpenAI call',
    );
  }
}

function connectControlWs(openaiCallId: string, state: FSCallState): void {
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${openaiCallId}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    },
  );

  state.controlWs = ws;
  let greetingSent = false;
  let conversationStarted = false; // true after first speech from either side

  ws.on('open', () => {
    logger.info({ callId: state.callId }, 'FS: Control WebSocket connected');
    // Disable VAD immediately, then send greeting
    ws.send(JSON.stringify({
      type: 'session.update',
      session: { turn_detection: null },
    }));
    // Don't wait for session.updated — send greeting right away
    const greetText = state.direction === 'outbound'
      ? `Greet the person in German. Say: "Hallo, hier ist Andy, der Assistent von Carsten." Then explain: ${state.goal}`
      : 'Greet the caller in German. Say: "Hallo, hier ist Andy, wie kann ich helfen?"';
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: greetText }],
      },
    }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    greetingSent = true;
    logger.info({ callId: state.callId }, 'FS: Greeting sent on WS open (VAD disabled)');
  });

  ws.on('message', (data: Buffer) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Log event types (skip noisy ones)
    const eventType = event.type as string;
    if (!eventType?.includes('audio_buffer') && !eventType?.includes('delta')) {
      logger.info({ callId: state.callId }, `FS: WS event: ${eventType}`);
    }

    switch (event.type) {
      // --- Event-driven greeting state machine ---
      case 'session.created':
        logger.info({ callId: state.callId }, 'FS: Session created');
        break;

      case 'session.updated':
        logger.info({ callId: state.callId }, 'FS: Session updated');
        break;

      case 'response.done':
        // Re-enable VAD after greeting completes
        if (!conversationStarted) {
          conversationStarted = true;
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          }));
          logger.info({ callId: state.callId }, 'FS: VAD re-enabled after greeting');

          // Start mid-call silence monitor (30s → "Bist du noch da?" → 10s → hangup)
          const midCallTimer = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'Nobody has spoken for a while. Ask: "Bist du noch da?"' }],
                },
              }));
              ws.send(JSON.stringify({ type: 'response.create' }));
              logger.info({ callId: state.callId }, 'FS: Mid-call silence check (30s)');
            }
            const hangupTimer = setTimeout(() => {
              logger.info({ callId: state.callId }, 'FS: No response after silence check, hanging up');
              cleanupCall(state.callId);
            }, 10000);
            state.timers.push(hangupTimer);
          }, 30000);
          state.timers.push(midCallTimer);
        }
        break;

      case 'input_audio_buffer.speech_started':
        // Callee spoke — cancel any silence timers, mark conversation started
        if (!conversationStarted) conversationStarted = true;
        for (const t of state.timers) clearTimeout(t);
        state.timers.length = 0;
        break;

      // --- Transcript handlers ---
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text && state.transcript.length < MAX_TRANSCRIPT_TURNS) {
            state.transcript.push({ role: 'user', text });
            logger.info({ callId: state.callId, text }, 'FS: Caller said');
          }
        }
        break;
      case 'response.audio_transcript.done':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text && state.transcript.length < MAX_TRANSCRIPT_TURNS) {
            state.transcript.push({ role: 'assistant', text });
            logger.info({ callId: state.callId, text }, 'FS: Andy said');
          }
        }
        break;
      case 'error':
        logger.error(
          { callId: state.callId, error: JSON.stringify(event.error || event) },
          'FS: OpenAI Realtime error',
        );
        break;
    }
  });

  ws.on('close', () => {
    logger.info({ callId: state.callId }, 'FS: Control WebSocket closed');
    // WebSocket close means the call ended on OpenAI's side — clean up
    cleanupCallState(state.callId);
  });

  ws.on('error', (err) => {
    logger.error({ callId: state.callId, err }, 'FS: Control WebSocket error');
  });
}

// --- Call cleanup ---

/**
 * Remove call from activeCalls and send transcript summary.
 * Does NOT close the WebSocket or kill the FS channel (use cleanupCall for full teardown).
 */
function cleanupCallState(callId: string): void {
  const state = activeCalls.get(callId);
  if (!state) return;
  activeCalls.delete(callId);

  // Clear any pending timers (greeting delays, etc.)
  for (const t of state.timers) clearTimeout(t);
  state.timers.length = 0;

  if (voiceDeps) {
    const summary = buildSummary(state);
    // Try chatJid first, then fall back to any reachable main group
    const jids = state.chatJid ? [state.chatJid] : [];
    if (voiceDeps.getMainJid && voiceDeps.getMainJid() && !jids.includes(voiceDeps.getMainJid()!)) {
      jids.push(voiceDeps.getMainJid()!);
    }
    for (const jid of jids) {
      try {
        voiceDeps.sendMessage(jid, summary).catch(() => {});
        break; // sent successfully
      } catch {
        /* try next JID */
      }
    }
  }

  logger.info({ callId }, 'FS: Call state cleaned up');
}

/**
 * Full teardown: close WebSocket, kill FS channel, then clean up state.
 */
function cleanupCall(callId: string): void {
  const state = activeCalls.get(callId);
  if (!state) return;

  if (state.controlWs?.readyState === WebSocket.OPEN) {
    state.controlWs.close();
  }

  // Kill the FreeSWITCH channel if still alive
  if (eslConn && state.fsUuid) {
    try {
      eslConn.api(`uuid_kill ${state.fsUuid}`, () => {});
    } catch {
      /* ignore */
    }
  }

  cleanupCallState(callId);
}

function buildSummary(state: FSCallState): string {
  const turns = state.transcript
    .map((t) => `${t.role === 'user' ? 'Andere Seite' : 'Andy'}: ${t.text}`)
    .join('\n');
  return `📞 FreeSWITCH-Anruf abgeschlossen.\nZiel: ${state.goal}\n\n${turns || '(Kein Transkript verfügbar)'}`;
}

// --- Outbound calls via ESL ---

export async function makeFreeswitchCall(
  to: string,
  goal: string,
  chatJid: string,
  voice?: string,
): Promise<void> {
  const callVoice = voice || DEFAULT_VOICE;
  if (!eslConn) throw new Error('FreeSWITCH ESL not connected');
  if (!PROJECT_ID) throw new Error('OPENAI_PROJECT_ID not configured');

  const callId = `fs-out-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  logger.info(
    { callId, to, goal },
    'FS: Initiating outbound call via FreeSWITCH',
  );

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
    controlWs: null,
    transcript: [],
    timers: [],
  };
  activeCalls.set(callId, state);

  try {
    // Step 1: Originate call to Sipgate, park the channel
    const originateArgs = `{origination_caller_id_number=+49308687022346,origination_caller_id_name=Andy,hangup_after_bridge=true}sofia/gateway/sipgate/${to} &park()`;

    const uuid = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Originate timeout (45s)')),
        45000,
      );
      eslConn.api(`originate ${originateArgs}`, (res: any) => {
        clearTimeout(timeout);
        const body = res?.body || res?.getBody?.() || '';
        if (body.startsWith('+OK')) {
          const channelUuid = body.replace('+OK ', '').trim();
          resolve(channelUuid);
        } else {
          reject(new Error(`Originate failed: ${body}`));
        }
      });
    });

    state.fsUuid = uuid;
    logger.info({ callId, uuid }, 'FS: Call answered, channel parked');

    if (voiceDeps && chatJid) {
      voiceDeps
        .sendMessage(chatJid, '📞 Verbunden, bridge zu OpenAI...')
        .catch(() => {});
    }

    // Step 2: Register webhook handler for OpenAI
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

    // Step 3: Set OpenAI project ID on channel, then transfer to openai dialplan
    eslConn.api(
      `uuid_setvar ${uuid} openai_project_id ${PROJECT_ID}`,
      () => {},
    );
    const transferCmd = `uuid_transfer ${uuid} openai XML public`;
    logger.info({ callId, transferCmd }, 'FS: Transferring to OpenAI bridge');

    eslConn.api(transferCmd, (res: any) => {
      const body = res?.body || res?.getBody?.() || '';
      logger.info({ callId, result: body.trim() }, 'FS: Transfer result');
    });

    // Step 4: Wait for OpenAI webhook (resolved by openai-webhook handler)
    await webhookPromise;

    // Step 4b: Accept the OpenAI call (webhook set the openaiCallId on state)
    if (state.openaiCallId) {
      await acceptOpenAICall(state.openaiCallId, state);
    }

    // Greeting is sent via event-driven state machine in connectControlWs
    // (session.created → disable VAD → session.updated → conversation.item.create → response.create)

    // Step 6: Subscribe to hangup for this channel
    eslConn.api(`uuid_setvar ${uuid} nanoclaw_call_id ${callId}`, () => {});
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

// --- Inbound call handler (webhook-triggered, no ESL needed) ---

export function handleFSInboundWebhook(openaiCallId: string): void {
  const callId = `fs-in-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
  logger.info(
    { callId, openaiCallId },
    'FS: Handling inbound call via webhook',
  );

  const state: FSCallState = {
    callId,
    fsUuid: '', // unknown — FS handles the bridge via dialplan
    openaiCallId,
    goal: 'Incoming call — answer and help the caller',
    chatJid: '',
    direction: 'inbound',
    voice: DEFAULT_VOICE,
    controlWs: null,
    transcript: [],
    timers: [],
  };

  // Find a working chat JID to send notifications/transcript to
  if (voiceDeps) {
    const mainJid = voiceDeps.getMainJid();
    if (mainJid) {
      state.chatJid = mainJid;
      try {
        voiceDeps.sendMessage(mainJid, 'Eingehender Anruf (FreeSWITCH)').catch(() => {});
      } catch {
        // Main JID channel not connected — try Discord fallback
        state.chatJid = 'dc:1490365616518070407';
        try {
          voiceDeps.sendMessage(state.chatJid, 'Eingehender Anruf (FreeSWITCH)').catch(() => {});
        } catch { /* no channel available */ }
      }
    }
  }

  activeCalls.set(callId, state);

  // Accept + connect control WebSocket
  acceptOpenAICall(openaiCallId, state).catch((err) => {
    logger.error({ callId, err: err?.message }, 'FS: Inbound accept failed');
    cleanupCall(callId);
  });
}

// Inbound is handled via webhook only (handleFSInboundWebhook above).
// FreeSWITCH dialplan bridges inbound calls directly to OpenAI.
// No ESL-based inbound detection needed.

// --- ESL connection and event handling ---

let eslReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleESLReconnect(): void {
  // Prevent duplicate reconnect timers from error + end both firing
  if (eslReconnectTimer) return;
  eslConn = null;
  eslReconnectTimer = setTimeout(() => {
    eslReconnectTimer = null;
    connectESL();
  }, 5000);
}

function connectESL(): void {
  logger.info(
    { host: ESL_HOST, port: ESL_PORT },
    'FS: Connecting to FreeSWITCH ESL',
  );

  eslConn = new esl.Connection(ESL_HOST, ESL_PORT, ESL_PASSWORD, () => {
    logger.info('FS: ESL connected');
  });

  eslConn.on('error', (err: any) => {
    logger.error({ err: err?.message }, 'FS: ESL connection error');
    scheduleESLReconnect();
  });

  eslConn.on('esl::end', () => {
    logger.warn('FS: ESL connection closed, reconnecting in 5s');
    scheduleESLReconnect();
  });
}

// --- Public API ---

export function startFreeswitchVoice(deps: FreeswitchVoiceDeps): void {
  voiceDeps = deps;

  if (!PROJECT_ID) {
    logger.warn('OPENAI_PROJECT_ID not set — FreeSWITCH voice not started');
    return;
  }

  connectESL();
  logger.info(
    { eslHost: ESL_HOST, eslPort: ESL_PORT },
    'FS: FreeSWITCH voice initialized (webhook via openai-webhook on 4402)',
  );
}
