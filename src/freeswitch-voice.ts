import crypto from 'crypto';
import OpenAI from 'openai';
import { WebSocket } from 'ws';
import express from 'express';
// @ts-ignore — no type declarations for modesl
import esl from 'modesl';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile([
  'OPENAI_SIP_API_KEY',
  'HINDSIGHT_LLM_API_KEY',
  'OPENAI_REALTIME_VOICE',
  'OPENAI_PROJECT_ID',
  'OPENAI_WEBHOOK_SECRET',
  'FREESWITCH_ESL_HOST',
  'FREESWITCH_ESL_PORT',
  'FREESWITCH_ESL_PASSWORD',
  'FREESWITCH_WEBHOOK_PORT',
]);

const OPENAI_API_KEY =
  env.OPENAI_SIP_API_KEY || env.HINDSIGHT_LLM_API_KEY || '';
const REALTIME_VOICE = env.OPENAI_REALTIME_VOICE || 'coral';
const PROJECT_ID = env.OPENAI_PROJECT_ID || '';
const WEBHOOK_SECRET = env.OPENAI_WEBHOOK_SECRET || '';
const ESL_HOST = env.FREESWITCH_ESL_HOST || '10.0.0.1';
const ESL_PORT = parseInt(env.FREESWITCH_ESL_PORT || '8021', 10);
const ESL_PASSWORD = env.FREESWITCH_ESL_PASSWORD || 'ClueCon';
const WEBHOOK_PORT = parseInt(env.FREESWITCH_WEBHOOK_PORT || '4403', 10);

const OPENAI_SIP_URI = `sofia/external/sip:${PROJECT_ID}@sip.api.openai.com;transport=tls`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let eslConn: any = null;

// --- Call state ---

interface FSCallState {
  callId: string;
  fsUuid: string; // FreeSWITCH channel UUID
  openaiCallId: string | null;
  goal: string;
  chatJid: string;
  direction: 'inbound' | 'outbound';
  controlWs: WebSocket | null;
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
}

const activeCalls = new Map<string, FSCallState>();

// Exported so sipgate-voice webhook handler can check FreeSWITCH pending calls too
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
        output: { voice: REALTIME_VOICE },
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

  ws.on('open', () => {
    logger.info({ callId: state.callId }, 'FS: Control WebSocket connected');
    if (state.direction === 'outbound') {
      // Greeting deferred: sent after bridge is established (see makeFreeswitchCall)
      logger.info({ callId: state.callId }, 'FS: Outbound WS open, greeting deferred');
    } else {
      // Inbound: greet after 2s silence
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'response.create',
              response: {
                instructions: `The caller hasn't spoken yet. Greet them: "Hallo, hier ist Andy, wie kann ich helfen?"`,
              },
            }),
          );
          logger.info({ callId: state.callId }, 'FS: Inbound greeting sent after 2s');
        }
      }, 2000);
    }
  });

  ws.on('message', (data: Buffer) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text) {
            state.transcript.push({ role: 'user', text });
            logger.info({ callId: state.callId, text }, 'FS: Caller said');
          }
        }
        break;
      case 'response.audio_transcript.done':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text) {
            state.transcript.push({ role: 'assistant', text });
            logger.info({ callId: state.callId, text }, 'FS: Andy said');
          }
        }
        break;
      case 'error':
        logger.error(
          { callId: state.callId, error: event.error },
          'FS: OpenAI Realtime error',
        );
        break;
    }
  });

  ws.on('close', () => {
    logger.info({ callId: state.callId }, 'FS: Control WebSocket closed');
  });

  ws.on('error', (err) => {
    logger.error({ callId: state.callId, err }, 'FS: Control WebSocket error');
  });
}

// --- Call cleanup ---

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

  if (voiceDeps && state.chatJid) {
    const summary = buildSummary(state);
    try {
      voiceDeps.sendMessage(state.chatJid, summary).catch(() => {});
    } catch {
      /* channel may be unavailable */
    }
  }

  activeCalls.delete(callId);
  logger.info({ callId }, 'FS: Call cleaned up');
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
): Promise<void> {
  if (!eslConn) throw new Error('FreeSWITCH ESL not connected');
  if (!PROJECT_ID) throw new Error('OPENAI_PROJECT_ID not configured');

  const callId = `fs-out-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  logger.info(
    { callId, to, goal },
    'FS: Initiating outbound call via FreeSWITCH',
  );

  if (voiceDeps && chatJid) {
    voiceDeps.sendMessage(chatJid, `📞 Rufe ${to} an (FreeSWITCH)...`).catch(() => {});
  }

  const state: FSCallState = {
    callId,
    fsUuid: '',
    openaiCallId: null,
    goal,
    chatJid,
    direction: 'outbound',
    controlWs: null,
    transcript: [],
  };
  activeCalls.set(callId, state);

  try {
    // Step 1: Originate call to Sipgate, park the channel
    const originateCmd = `originate {origination_caller_id_number=+49308687022346,origination_caller_id_name=Andy,hangup_after_bridge=true}sofia/gateway/sipgate/${to} &park()`;

    const uuid = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Originate timeout (45s)')),
        45000,
      );
      eslConn.api(`originate ${originateCmd.replace('originate ', '')}`, (res: any) => {
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
      voiceDeps.sendMessage(chatJid, '📞 Verbunden, bridge zu OpenAI...').catch(() => {});
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
    eslConn.api(`uuid_setvar ${uuid} openai_project_id ${PROJECT_ID}`, () => {});
    const transferCmd = `uuid_transfer ${uuid} openai`;
    logger.info({ callId, transferCmd }, 'FS: Transferring to OpenAI bridge');

    eslConn.api(transferCmd, (res: any) => {
      const body = res?.body || res?.getBody?.() || '';
      logger.info({ callId, result: body.trim() }, 'FS: Transfer result');
    });

    // Step 4: Wait for OpenAI webhook (resolved by sipgate-voice webhook handler)
    await webhookPromise;

    // Step 4b: Accept the OpenAI call (webhook set the openaiCallId on state)
    if (state.openaiCallId) {
      await acceptOpenAICall(state.openaiCallId, state);
    }

    // Step 5: Send greeting after bridge is established
    setTimeout(() => {
      if (state.controlWs?.readyState === WebSocket.OPEN) {
        state.controlWs.send(
          JSON.stringify({
            type: 'response.create',
            response: {
              instructions: `Greet the person and explain why you are calling. Your goal: ${state.goal}`,
            },
          }),
        );
        logger.info({ callId }, 'FS: Outbound greeting sent');
      }
    }, 1000);

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

// --- ESL connection and event handling ---

function connectESL(): void {
  logger.info({ host: ESL_HOST, port: ESL_PORT }, 'FS: Connecting to FreeSWITCH ESL');

  eslConn = new esl.Connection(ESL_HOST, ESL_PORT, ESL_PASSWORD, () => {
    logger.info('FS: ESL connected');

    // Subscribe to channel events
    eslConn.subscribe(['CHANNEL_ANSWER', 'CHANNEL_HANGUP_COMPLETE', 'CHANNEL_CREATE']);

    eslConn.on('esl::event::CHANNEL_HANGUP_COMPLETE::*', (event: any) => {
      const uuid = event.getHeader('Unique-ID') || '';
      const nanoclaw_id = event.getHeader('variable_nanoclaw_call_id') || '';

      // Find matching call by UUID or nanoclaw_call_id
      for (const [callId, state] of activeCalls) {
        if (state.fsUuid === uuid || callId === nanoclaw_id) {
          logger.info({ callId, uuid }, 'FS: Channel hung up');
          cleanupCall(callId);
          break;
        }
      }
    });

    // Handle inbound calls from Sipgate (parked by dialplan)
    eslConn.on('esl::event::CHANNEL_ANSWER::*', (event: any) => {
      const direction = event.getHeader('Call-Direction') || '';
      const uuid = event.getHeader('Unique-ID') || '';
      const callerNumber = event.getHeader('Caller-Caller-ID-Number') || 'unknown';
      const gateway = event.getHeader('variable_sip_gateway') || '';

      // Only handle inbound from Sipgate gateway
      if (direction !== 'inbound' || !gateway.includes('sipgate')) return;

      // Check if we already have this UUID
      for (const state of activeCalls.values()) {
        if (state.fsUuid === uuid) return;
      }

      const callId = `fs-in-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
      logger.info(
        { callId, uuid, from: callerNumber },
        'FS: Inbound call from Sipgate',
      );

      const state: FSCallState = {
        callId,
        fsUuid: uuid,
        openaiCallId: null,
        goal: `Incoming call from ${callerNumber}`,
        chatJid: '',
        direction: 'inbound',
        controlWs: null,
        transcript: [],
      };

      if (voiceDeps) {
        const mainJid = voiceDeps.getMainJid();
        if (mainJid) {
          state.chatJid = mainJid;
          voiceDeps
            .sendMessage(mainJid, `Eingehender Anruf von ${callerNumber} (FreeSWITCH)`)
            .catch(() => {});
        }
      }

      activeCalls.set(callId, state);

      // Register webhook handler
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

      // Bridge to OpenAI via dialplan transfer
      eslConn.api(`uuid_setvar ${uuid} openai_project_id ${PROJECT_ID}`, () => {});
      eslConn.api(`uuid_transfer ${uuid} openai`, (res: any) => {
        const body = res?.body || res?.getBody?.() || '';
        logger.info({ callId, result: body.trim() }, 'FS: Inbound transfer result');
      });

      eslConn.api(`uuid_setvar ${uuid} nanoclaw_call_id ${callId}`, () => {});

      webhookPromise.catch((err) => {
        logger.error({ callId, err: err?.message }, 'FS: Inbound webhook failed');
        cleanupCall(callId);
      });
    });
  });

  eslConn.on('error', (err: any) => {
    logger.error({ err: err?.message }, 'FS: ESL connection error');
    eslConn = null;
    // Reconnect after 5s
    setTimeout(connectESL, 5000);
  });

  eslConn.on('esl::end', () => {
    logger.warn('FS: ESL connection closed, reconnecting in 5s');
    eslConn = null;
    setTimeout(connectESL, 5000);
  });
}

// --- Webhook server for OpenAI SIP callbacks ---

function startWebhookServer(): void {
  const app = express();
  app.use(express.raw({ type: 'application/json' }));

  app.post('/openai-sip-fs', async (req, res) => {
    const rawBody = req.body.toString();
    logger.info(
      { bodyLen: rawBody.length, webhookId: req.headers['webhook-id'] },
      'FS: Webhook received',
    );

    let event: any;
    try {
      if (WEBHOOK_SECRET) {
        event = await openai.webhooks.unwrap(rawBody, req.headers, WEBHOOK_SECRET);
      } else {
        event = JSON.parse(rawBody);
      }
    } catch (err: any) {
      logger.error({ err: err?.message }, 'FS: Webhook signature failed, accepting anyway');
      try {
        event = JSON.parse(rawBody);
      } catch {
        res.status(400).send('Invalid JSON');
        return;
      }
    }

    if (event.type === 'realtime.call.incoming') {
      const openaiCallId = event.call_id || event.data?.call_id;

      // Check pending outbound calls first
      for (const [key, pending] of pendingFSWebhook) {
        logger.info({ callId: key, openaiCallId }, 'FS: Matched webhook to call');
        pending.state.openaiCallId = openaiCallId;
        pendingFSWebhook.delete(key);
        res.status(200).send('OK');
        acceptOpenAICall(openaiCallId, pending.state)
          .then(() => pending.resolve())
          .catch((err) => pending.reject(err));
        return;
      }

      // No matching call
      logger.warn({ openaiCallId }, 'FS: No matching call for webhook');
      res.status(200).send('OK');
      try {
        await openai.realtime.calls.reject(openaiCallId, { status_code: 486 });
      } catch {
        /* ignore */
      }
      return;
    }

    res.status(200).send('OK');
  });

  app.listen(WEBHOOK_PORT, '0.0.0.0', () => {
    logger.info({ port: WEBHOOK_PORT }, 'FS: OpenAI webhook server started');
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
  // No separate webhook server — FreeSWITCH pending calls are checked
  // by the sipgate-voice webhook handler via the exported pendingFSWebhook map.

  logger.info(
    { eslHost: ESL_HOST, eslPort: ESL_PORT },
    'FS: FreeSWITCH voice initialized (webhook shared with sipgate on 4402)',
  );
}
