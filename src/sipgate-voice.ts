import express from 'express';
import crypto from 'crypto';
import OpenAI from 'openai';
import { WebSocket } from 'ws';
import Srf from 'drachtio-srf';
// @ts-ignore — no type declarations
import RtpEngineClient from '@jambonz/rtpengine-utils';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile([
  'SIPGATE_SIP_URI',
  'SIPGATE_SIP_PASSWORD',
  'SIPGATE_TOKEN_ID',
  'SIPGATE_TOKEN',
  'OPENAI_SIP_API_KEY',
  'HINDSIGHT_LLM_API_KEY',
  'OPENAI_REALTIME_VOICE',
  'OPENAI_PROJECT_ID',
  'OPENAI_WEBHOOK_SECRET',
  'SIPGATE_VOICE_PORT',
]);

const SIP_USER = env.SIPGATE_SIP_URI?.replace(/^sip:/, '').split('@')[0] || '';
const SIP_DOMAIN =
  env.SIPGATE_SIP_URI?.replace(/^sip:/, '').split('@')[1] || 'sipgate.de';
const SIP_PASSWORD = env.SIPGATE_SIP_PASSWORD || '';
const SIPGATE_TOKEN_ID = env.SIPGATE_TOKEN_ID || '';
const SIPGATE_TOKEN = env.SIPGATE_TOKEN || '';
const OPENAI_API_KEY =
  env.OPENAI_SIP_API_KEY || env.HINDSIGHT_LLM_API_KEY || '';
const REALTIME_VOICE = env.OPENAI_REALTIME_VOICE || 'coral';
const PROJECT_ID = env.OPENAI_PROJECT_ID || '';
const WEBHOOK_SECRET = env.OPENAI_WEBHOOK_SECRET || '';
const PORT = parseInt(env.SIPGATE_VOICE_PORT || '4402', 10);
const DEVICE_ID = 'e2';
const HETZNER_PUBLIC_IP = '128.140.104.236';

const OPENAI_SIP_URI = `sip:${PROJECT_ID}@sip.api.openai.com;transport=tls`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let rtpEngine: any = null;

// --- Call state ---

interface SipgateCallState {
  callId: string;
  sipCallId: string; // SIP Call-ID for rtpengine cleanup
  fromTag: string; // from-tag for rtpengine cleanup
  openaiCallId: string | null;
  goal: string;
  chatJid: string;
  direction: 'inbound' | 'outbound';
  controlWs: WebSocket | null;
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
  uasDialog: Srf.Dialog | null;
  uacDialog: Srf.Dialog | null;
}

const activeCalls = new Map<string, SipgateCallState>();

// Pending outbound calls: keyed by callee number
const pendingOutbound = new Map<
  string,
  { goal: string; chatJid: string; to: string }
>();

export interface SipgateVoiceDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getMainJid: () => string | undefined;
}

let voiceDeps: SipgateVoiceDeps | null = null;
let srf: InstanceType<typeof Srf> | null = null;

// --- OpenAI call accept + control WebSocket ---

async function acceptOpenAICall(
  openaiCallId: string,
  state: SipgateCallState,
): Promise<void> {
  logger.info(
    { callId: state.callId, openaiCallId, goal: state.goal },
    'Accepting call via OpenAI Realtime API',
  );

  try {
    await openai.realtime.calls.accept(openaiCallId, {
      type: 'realtime',
      model: 'gpt-4o-realtime-preview',
      instructions: `You are Andy, a personal assistant. You answer incoming phone calls for Carsten (Munich, Germany).
Speak German by default. Be friendly and helpful. Say "Hallo, hier ist Andy, wie kann ich helfen?" when the call starts.
If the caller speaks another language, switch to that language.
Keep responses short and natural.`,
      audio: {
        output: { voice: REALTIME_VOICE },
      },
    } as any);

    logger.info(
      { callId: state.callId, openaiCallId },
      'Call accepted by OpenAI',
    );
    connectControlWs(openaiCallId, state);
  } catch (err: any) {
    logger.error(
      { callId: state.callId, openaiCallId, err: err?.message },
      'Failed to accept OpenAI call',
    );
  }
}

function connectControlWs(openaiCallId: string, state: SipgateCallState): void {
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
    logger.info({ callId: state.callId }, 'Control WebSocket connected');
    // Trigger Andy's initial greeting immediately.
    // session.created may not fire until speech is detected in SIP Native mode,
    // so we send response.create right on connect.
    ws.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          instructions:
            state.direction === 'outbound'
              ? `Greet the person and explain why you are calling. Your goal: ${state.goal}`
              : 'Greet the caller: "Hallo, hier ist Andy, wie kann ich helfen?"',
        },
      }),
    );
    logger.info(
      { callId: state.callId, direction: state.direction },
      'Sent initial greeting trigger',
    );
  });

  ws.on('message', (data: Buffer) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    logger.info({ callId: state.callId, type: event.type }, 'WS event');

    switch (event.type) {
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text) {
            state.transcript.push({ role: 'user', text });
            logger.info({ callId: state.callId, text }, 'Caller said');
          }
        }
        break;

      case 'response.audio_transcript.done':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text) {
            state.transcript.push({ role: 'assistant', text });
            logger.info({ callId: state.callId, text }, 'Andy said');
          }
        }
        break;

      case 'session.created':
        logger.info({ callId: state.callId }, 'OpenAI session created');
        break;

      case 'error':
        logger.error(
          { callId: state.callId, error: event.error },
          'OpenAI Realtime error',
        );
        break;
    }
  });

  ws.on('close', () => {
    logger.info({ callId: state.callId }, 'Control WebSocket closed');
  });

  ws.on('error', (err) => {
    logger.error({ callId: state.callId, err }, 'Control WebSocket error');
  });
}

// --- Call cleanup ---

function cleanupCall(callId: string): void {
  const state = activeCalls.get(callId);
  if (!state) return;

  if (state.controlWs?.readyState === WebSocket.OPEN) {
    state.controlWs.close();
  }
  if (state.uasDialog) {
    try {
      state.uasDialog.destroy();
    } catch {
      /* already ended */
    }
  }
  if (state.uacDialog) {
    try {
      state.uacDialog.destroy();
    } catch {
      /* already ended */
    }
  }

  // Free rtpengine media ports
  if (rtpEngine && state.sipCallId && state.fromTag) {
    try {
      rtpEngine.delete({
        'call-id': state.sipCallId,
        'from-tag': state.fromTag,
      });
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
  logger.info({ callId }, 'Sipgate call cleaned up');
}

function buildSummary(state: SipgateCallState): string {
  const turns = state.transcript
    .map((t) => `${t.role === 'user' ? 'Andere Seite' : 'Andy'}: ${t.text}`)
    .join('\n');
  return `📞 Sipgate-Anruf abgeschlossen.\nZiel: ${state.goal}\n\n${turns || '(Kein Transkript verfügbar)'}`;
}

// --- Outbound calls via Sipgate REST API ---

export async function makeSipgateCall(
  to: string,
  goal: string,
  chatJid: string,
): Promise<void> {
  if (!SIPGATE_TOKEN_ID || !SIPGATE_TOKEN) {
    throw new Error('Sipgate API token not configured');
  }
  if (!PROJECT_ID) {
    throw new Error('OPENAI_PROJECT_ID not configured');
  }

  pendingOutbound.set(to, { goal, chatJid, to });

  const auth = Buffer.from(`${SIPGATE_TOKEN_ID}:${SIPGATE_TOKEN}`).toString(
    'base64',
  );

  logger.info(
    { to, goal, deviceId: DEVICE_ID },
    'Initiating sipgate outbound call',
  );

  try {
    const response = await fetch('https://api.sipgate.com/v2/sessions/calls', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        callee: to,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error(
        { status: response.status, body, to },
        'Sipgate REST API call failed',
      );
      pendingOutbound.delete(to);
      throw new Error(`Sipgate API error ${response.status}: ${body}`);
    }

    const result = (await response.json()) as { sessionId?: string };
    logger.info(
      { sessionId: result.sessionId, to },
      'Sipgate outbound call initiated',
    );

    setTimeout(() => {
      if (pendingOutbound.has(to)) {
        pendingOutbound.delete(to);
        logger.warn({ to }, 'Sipgate outbound call timed out');
      }
    }, 30000);
  } catch (err: any) {
    logger.error({ message: err?.message, to }, 'Sipgate outbound call error');
    pendingOutbound.delete(to);
    throw err;
  }
}

// --- SIP Registration with Sipgate ---

let registerInterval: ReturnType<typeof setInterval> | null = null;

async function registerWithSipgate(): Promise<void> {
  if (!srf) return;

  try {
    // Register via TLS so Sipgate enables SRTP for media (required for OpenAI)
    const req = await (srf as any).request({
      uri: `sip:sip.${SIP_DOMAIN};transport=tls`,
      method: 'REGISTER',
      headers: {
        To: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        From: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        Contact: `<sip:${SIP_USER}@${HETZNER_PUBLIC_IP}:5061;transport=tls>`,
        Expires: '300',
      },
    } as any);

    (req as any).on('response', (res: any) => {
      const status = res?.msg?.status ?? res?.status;
      const reason = res?.msg?.reason ?? '';
      logger.info({ status, reason }, 'SIP REGISTER response');
      if (status === 200) {
        logger.info('SIP REGISTER successful with sipgate');
      } else if (status === 401 || status === 407) {
        handleRegisterChallenge(res);
      } else {
        logger.warn({ status, reason }, 'SIP REGISTER unexpected response');
      }
    });

    if (!registerInterval) {
      registerInterval = setInterval(() => {
        registerWithSipgate().catch((err) => {
          logger.error({ err }, 'SIP re-registration failed');
        });
      }, 240000);
    }
  } catch (err) {
    logger.error({ err }, 'SIP REGISTER failed');
  }
}

function handleRegisterChallenge(res: any): void {
  if (!srf) return;

  const hdrs = res?.msg?.headers || {};
  const authHeader = hdrs['www-authenticate'] || hdrs['proxy-authenticate'];
  if (!authHeader) {
    const alt =
      res.get?.('www-authenticate') || res.get?.('proxy-authenticate');
    if (!alt) {
      logger.warn('No WWW-Authenticate header in 401 response');
      return;
    }
    return handleRegisterChallengeWithHeader(alt);
  }
  handleRegisterChallengeWithHeader(authHeader);
}

function handleRegisterChallengeWithHeader(authHeader: string): void {
  if (!srf) return;

  const realmMatch = authHeader.match(/realm="([^"]+)"/);
  const nonceMatch = authHeader.match(/nonce="([^"]+)"/);
  if (!realmMatch || !nonceMatch) return;

  const realm = realmMatch[1];
  const nonce = nonceMatch[1];
  const ha1 = crypto
    .createHash('md5')
    .update(`${SIP_USER}:${realm}:${SIP_PASSWORD}`)
    .digest('hex');
  const ha2 = crypto
    .createHash('md5')
    .update(`REGISTER:sip:${SIP_DOMAIN}`)
    .digest('hex');
  const response = crypto
    .createHash('md5')
    .update(`${ha1}:${nonce}:${ha2}`)
    .digest('hex');
  const authValue = `Digest username="${SIP_USER}", realm="${realm}", nonce="${nonce}", uri="sip:${SIP_DOMAIN}", response="${response}", algorithm=MD5`;

  (srf as any)
    .request({
      uri: `sip:sip.${SIP_DOMAIN};transport=tls`,
      method: 'REGISTER',
      headers: {
        To: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        From: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        Contact: `<sip:${SIP_USER}@${HETZNER_PUBLIC_IP}:5061;transport=tls>`,
        Expires: '300',
        Authorization: authValue,
      },
    } as any)
    .then((req2: any) => {
      (req2 as any).on('response', (res2: any) => {
        const status2 = res2?.msg?.status ?? res2?.status;
        if (status2 === 200) {
          logger.info('SIP REGISTER authenticated successfully with sipgate');
        } else {
          logger.error({ status: status2 }, 'SIP REGISTER auth failed');
        }
      });
    })
    .catch((err: any) => {
      logger.error({ err }, 'SIP REGISTER auth request failed');
    });
}

// --- RTP latching trigger ---

/**
 * Send silence RTP via rtpengine playMedia to trigger symmetric NAT latching.
 * Both Sipgate and OpenAI wait for incoming RTP before sending (symmetric RTP).
 * playMedia injects packets from rtpengine's allocated ports into both legs,
 * breaking the deadlock.
 */
function triggerRtpLatching(
  sipCallId: string,
  fromTag: string,
  callId: string,
): void {
  if (!rtpEngine) return;

  const playOpts = {
    'call-id': sipCallId,
    'from-tag': fromTag,
    file: '/media/silence.wav',
    'repeat-times': '3', // play 3× (3 seconds total) to ensure latching
    duration: '1000', // 1 second per play
  };

  // Play into Sipgate leg (from-tag side)
  rtpEngine
    .playMedia(playOpts)
    .then((res: any) => {
      logger.info({ callId, result: res?.result }, 'playMedia → Sipgate leg');
    })
    .catch((err: any) => {
      logger.warn(
        { callId, err: err?.message },
        'playMedia → Sipgate leg failed',
      );
    });

  // Small delay, then play into OpenAI leg (to-tag side) — to-tag may
  // not be known until answer completes, so we query rtpengine for the call
  setTimeout(() => {
    rtpEngine
      .query({ 'call-id': sipCallId, 'from-tag': fromTag })
      .then((qRes: any) => {
        const toTag = qRes?.tags
          ? Object.keys(qRes.tags).find((t: string) => t !== fromTag)
          : null;
        if (toTag) {
          rtpEngine
            .playMedia({ ...playOpts, 'from-tag': toTag })
            .then((res: any) => {
              logger.info(
                { callId, result: res?.result },
                'playMedia → OpenAI leg',
              );
            })
            .catch((err: any) => {
              logger.warn(
                { callId, err: err?.message },
                'playMedia → OpenAI leg failed',
              );
            });
        } else {
          logger.warn(
            { callId },
            'No to-tag found — OpenAI leg playMedia skipped',
          );
        }
      })
      .catch((err: any) => {
        logger.warn(
          { callId, err: err?.message },
          'rtpengine query for to-tag failed',
        );
      });
  }, 500);
}

// --- Inbound call handler: B2BUA bridge to OpenAI SIP ---

async function handleInboundCall(
  req: Srf.SrfRequest,
  res: Srf.SrfResponse,
): Promise<void> {
  const callId = `sg-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
  const from = req.callingNumber || 'unknown';
  const to = req.calledNumber || 'unknown';
  const sipCallId = req.get('Call-ID') || '';
  const fromTag = req.getParsedHeader('from')?.params?.tag || 'unknown';

  logger.info(
    { callId, from, to, uri: req.uri },
    'Incoming SIP INVITE from Sipgate',
  );

  // Check for pending outbound
  let pendingCall: { goal: string; chatJid: string; to: string } | undefined;
  for (const [key, pending] of pendingOutbound.entries()) {
    pendingCall = pending;
    pendingOutbound.delete(key);
    break;
  }

  const isOutbound = !!pendingCall;
  const goal =
    pendingCall?.goal ||
    `Incoming call from ${from} — answer and help the caller`;
  const chatJid = pendingCall?.chatJid || '';

  const state: SipgateCallState = {
    callId,
    sipCallId,
    fromTag,
    openaiCallId: null,
    goal,
    chatJid,
    direction: isOutbound ? 'outbound' : 'inbound',
    controlWs: null,
    transcript: [],
    uasDialog: null,
    uacDialog: null,
  };

  // For inbound, notify main group
  if (!isOutbound && voiceDeps) {
    const mainJid = voiceDeps.getMainJid();
    if (mainJid) {
      state.chatJid = mainJid;
      try {
        voiceDeps
          .sendMessage(mainJid, `Eingehender Sipgate-Anruf von ${from}`)
          .catch(() => {});
      } catch {
        /* channel may be unavailable */
      }
    }
  }

  activeCalls.set(callId, state);

  try {
    // B2BUA with rtpengine as media proxy
    // rtpengine relays SRTP between Sipgate and OpenAI via Hetzner public IP
    const sipgateSdp = req.body as string;
    const hasSrtp = sipgateSdp.includes('RTP/SAVP');
    logger.info(
      { callId, target: OPENAI_SIP_URI, hasSrtp },
      'Bridging to OpenAI SIP via B2BUA + rtpengine',
    );

    if (!rtpEngine) {
      throw new Error('rtpengine not initialized');
    }

    // Offer to rtpengine: Sipgate's SDP → get rtpengine's SDP for OpenAI
    const offerRes: any = await rtpEngine.offer({
      'call-id': sipCallId,
      'from-tag': fromTag,
      sdp: sipgateSdp,
      ICE: 'remove',
      DTLS: 'off',
      flags: ['asymmetric'],
      replace: ['origin', 'session-connection'],
      direction: ['external', 'external'],
      'transport-protocol': 'RTP/SAVP',
    });
    if (offerRes?.result !== 'ok') {
      throw new Error(
        `rtpengine offer failed: ${offerRes?.['error-reason'] || JSON.stringify(offerRes)}`,
      );
    }

    // Strip DTLS/fingerprint and unsupported crypto suites rtpengine adds.
    // Keep only AES_CM_128_HMAC_SHA1_80 — the only suite OpenAI accepts.
    const cleanSdp = (offerRes.sdp as string)
      .split('\r\n')
      .filter(
        (line: string) =>
          !line.startsWith('a=tls-id:') &&
          !line.startsWith('a=setup:') &&
          !line.startsWith('a=fingerprint:') &&
          !line.includes('NULL_HMAC') &&
          !line.includes('F8_128') &&
          !line.includes('AEAD_AES') &&
          !line.includes('AES_256_CM') &&
          !line.includes('AES_192_CM') &&
          !line.includes('AES_CM_128_HMAC_SHA1_32'),
      )
      .join('\r\n');
    logger.info(
      { callId, rtpSdpLen: cleanSdp.length, cleanSdp },
      'rtpengine offer OK, SDP cleaned',
    );

    const { uas, uac } = await srf!.createB2BUA(req, res, OPENAI_SIP_URI, {
      localSdpB: cleanSdp,
      proxyRequestHeaders: ['Call-ID'],
      localSdpA: async (sdp: string, sipRes: any): Promise<string> => {
        const toTag =
          sipRes?.getParsedHeader?.('to')?.params?.tag ||
          sipRes?.msg?.headers?.to?.match(/tag=([^;]+)/)?.[1] ||
          'openai';
        const answerRes: any = await rtpEngine.answer({
          'call-id': sipCallId,
          'from-tag': fromTag,
          'to-tag': toTag,
          sdp,
          ICE: 'remove',
          DTLS: 'off',
          flags: ['asymmetric'],
          replace: ['origin', 'session-connection'],
          direction: ['external', 'external'],
          'transport-protocol': 'RTP/SAVP',
        });
        if (answerRes?.result !== 'ok') {
          logger.error(
            { err: answerRes?.['error-reason'] },
            'rtpengine answer failed',
          );
          return sdp;
        }
        // Strip DTLS from answer too
        const cleanAnswer = (answerRes.sdp as string)
          .split('\r\n')
          .filter(
            (line: string) =>
              !line.startsWith('a=tls-id:') &&
              !line.startsWith('a=setup:') &&
              !line.startsWith('a=fingerprint:'),
          )
          .join('\r\n');
        logger.info({ callId }, 'rtpengine answer OK');
        return cleanAnswer;
      },
    });

    state.uasDialog = uas;
    state.uacDialog = uac;

    logger.info(
      { callId, isOutbound },
      'B2BUA bridge established: Sipgate ↔ OpenAI',
    );

    // Trigger Sipgate's RTP latching: both Sipgate and OpenAI use symmetric RTP
    // (wait for incoming before sending). rtpengine sits in between but generates
    // no traffic by itself → deadlock. playMedia injects silence RTP from
    // rtpengine's allocated ports, which triggers latching on both sides.
    triggerRtpLatching(sipCallId, fromTag, callId);

    uas.on('destroy', () => {
      logger.info({ callId }, 'Sipgate side hung up');
      try {
        uac.destroy();
      } catch {
        /* already ended */
      }
      cleanupCall(callId);
    });
    uac.on('destroy', () => {
      logger.info({ callId }, 'OpenAI side hung up');
      try {
        uas.destroy();
      } catch {
        /* already ended */
      }
      cleanupCall(callId);
    });
  } catch (err: any) {
    logger.error(
      { callId, errMsg: err?.message || String(err), status: err?.status },
      'B2BUA bridge failed',
    );
    cleanupCall(callId);
  }
}

// --- Webhook server: OpenAI SIP callbacks ---

function startWebhookServer(): void {
  const app = express();
  app.use(express.raw({ type: 'application/json' }));

  app.post('/openai-sip', async (req, res) => {
    const rawBody = req.body.toString();
    logger.info(
      {
        bodyLen: rawBody.length,
        webhookId: req.headers['webhook-id'],
        webhookTs: req.headers['webhook-timestamp'],
        hasSig: !!req.headers['webhook-signature'],
        hasSecret: !!WEBHOOK_SECRET,
      },
      'Webhook request received on /openai-sip',
    );

    let event: any;
    try {
      if (WEBHOOK_SECRET) {
        event = await openai.webhooks.unwrap(
          rawBody,
          req.headers,
          WEBHOOK_SECRET,
        );
      } else {
        event = JSON.parse(rawBody);
        logger.warn(
          'Webhook signature not verified — OPENAI_WEBHOOK_SECRET not set',
        );
      }
    } catch (err: any) {
      logger.error(
        { err: err?.message },
        'Webhook signature verification failed — accepting anyway',
      );
      try {
        event = JSON.parse(rawBody);
      } catch {
        res.status(400).send('Invalid JSON');
        return;
      }
    }

    logger.info(
      {
        type: event.type,
        callId: event.call_id || event.data?.call_id,
        activeCallCount: activeCalls.size,
      },
      'OpenAI webhook event parsed',
    );

    if (event.type === 'realtime.call.incoming') {
      const openaiCallId = event.call_id || event.data?.call_id;
      logger.info(
        { openaiCallId, activeCalls: [...activeCalls.keys()] },
        'Incoming call webhook — searching for matching active call',
      );

      let matchedState: SipgateCallState | null = null;
      for (const [, state] of activeCalls) {
        if (!state.openaiCallId) {
          state.openaiCallId = openaiCallId;
          matchedState = state;
          break;
        }
      }

      if (matchedState) {
        logger.info(
          { callId: matchedState.callId, openaiCallId },
          'Matched OpenAI webhook to active call — accepting',
        );
        res.status(200).send('OK');
        void acceptOpenAICall(openaiCallId, matchedState);
      } else {
        logger.warn(
          { openaiCallId, activeCallCount: activeCalls.size },
          'No matching active call for webhook — rejecting',
        );
        res.status(200).send('OK');
        try {
          await openai.realtime.calls.reject(openaiCallId, {
            status_code: 486,
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    res.status(200).send('OK');
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'OpenAI SIP webhook server started');
  });
}

// --- Public API ---

export function startSipgateVoice(deps: SipgateVoiceDeps): void {
  voiceDeps = deps;

  if (!SIP_USER || !SIP_PASSWORD) {
    logger.warn('Sipgate SIP credentials not configured — voice not started');
    return;
  }
  if (!PROJECT_ID) {
    logger.warn('OPENAI_PROJECT_ID not set — sipgate SIP voice not started');
    return;
  }

  // Init rtpengine client — call as function, not constructor
  const rtpUtils = RtpEngineClient(['127.0.0.1:22222']);
  rtpEngine = rtpUtils.getRtpEngine();
  logger.info('rtpengine client initialized');

  // Start drachtio connection for SIP signaling
  srf = new Srf();
  srf.connect({ host: '127.0.0.1', port: 9022, secret: 'cymru' });

  srf.on('connect', (_err: Error, hostPort: string) => {
    logger.info({ hostPort }, 'Connected to drachtio-server');
    registerWithSipgate().catch((err) => {
      logger.error({ err }, 'SIP registration failed');
    });
  });

  srf.on('error', (err: Error) => {
    logger.error({ err }, 'drachtio connection error');
  });

  srf.on('disconnect', () => {
    logger.warn('Disconnected from drachtio-server, will reconnect');
  });

  // Handle incoming SIP INVITEs — bridge to OpenAI
  srf.invite((req: Srf.SrfRequest, res: Srf.SrfResponse) => {
    handleInboundCall(req, res).catch((err) => {
      logger.error({ err }, 'Unhandled error in inbound call handler');
    });
  });

  // Start webhook server for OpenAI callbacks
  startWebhookServer();

  logger.info(
    { projectId: PROJECT_ID, sipUri: OPENAI_SIP_URI },
    'Sipgate voice initialized (B2BUA → OpenAI Native SIP)',
  );
}
