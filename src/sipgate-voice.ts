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
const OPENAI_API_KEY =
  env.OPENAI_SIP_API_KEY || env.HINDSIGHT_LLM_API_KEY || '';
const REALTIME_VOICE = env.OPENAI_REALTIME_VOICE || 'coral';
const PROJECT_ID = env.OPENAI_PROJECT_ID || '';
const WEBHOOK_SECRET = env.OPENAI_WEBHOOK_SECRET || '';
const PORT = parseInt(env.SIPGATE_VOICE_PORT || '4402', 10);
const DEVICE_ID = 'e5';
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
  _inviteReq?: any; // outbound INVITE request for cancellation
}

const activeCalls = new Map<string, SipgateCallState>();

// Promise-based correlation for outbound OpenAI webhooks
const pendingOpenAIWebhook = new Map<
  string,
  {
    state: SipgateCallState;
    resolve: () => void;
    reject: (err: Error) => void;
  }
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
    if (state.direction === 'outbound') {
      // Outbound: do NOT greet here. Greeting is triggered after Sipgate answers
      // (in buildOutboundEarlyOfferUDP). If we greet now, OpenAI buffers audio
      // for ~8s while the phone rings, then dumps it all at once → stuttering.
      logger.info(
        { callId: state.callId },
        'Outbound: WebSocket open, greeting deferred until Sipgate answers',
      );
    } else {
      // Inbound: wait 1.5s for caller to speak first (VAD), then greet if silent
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
          logger.info(
            { callId: state.callId },
            'Inbound greeting sent after 2s silence',
          );
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

// --- SDP cleaning helpers ---

/** Strip DTLS/fingerprint and unsupported crypto suites from rtpengine SDP.
 *  Keep only AES_CM_128_HMAC_SHA1_80 — the only suite OpenAI accepts. */
function cleanSdpForOpenAI(sdp: string): string {
  return sdp
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
}

/** Strip only bad crypto suites but KEEP DTLS fingerprint/setup (for OpenAI). */
function cleanSdpCryptoSuites(sdp: string): string {
  return sdp
    .split('\r\n')
    .filter(
      (line: string) =>
        !line.includes('NULL_HMAC') &&
        !line.includes('F8_128') &&
        !line.includes('AEAD_AES') &&
        !line.includes('AES_256_CM') &&
        !line.includes('AES_192_CM') &&
        !line.includes('AES_CM_128_HMAC_SHA1_32'),
    )
    .join('\r\n');
}

/** Strip DTLS attributes from answer SDP (for Sipgate side). */
function cleanSdpAnswer(sdp: string): string {
  return sdp
    .split('\r\n')
    .filter(
      (line: string) =>
        !line.startsWith('a=tls-id:') &&
        !line.startsWith('a=setup:') &&
        !line.startsWith('a=fingerprint:'),
    )
    .join('\r\n');
}

// --- Outbound calls via direct SIP INVITE ---

export async function makeSipgateCall(
  to: string,
  goal: string,
  chatJid: string,
): Promise<void> {
  if (!srf) throw new Error('drachtio not connected');
  if (!rtpEngine) throw new Error('rtpengine not initialized');
  if (!PROJECT_ID) throw new Error('OPENAI_PROJECT_ID not configured');

  const callId = `sg-out-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

  logger.info(
    { callId, to, goal },
    'Initiating outbound call (Late Offer / UDP)',
  );

  if (voiceDeps && chatJid) {
    voiceDeps.sendMessage(chatJid, `📞 Rufe ${to} an...`).catch(() => {});
  }

  const state: SipgateCallState = {
    callId,
    sipCallId: callId, // use synthetic ID for rtpengine correlation
    fromTag: `out-${crypto.randomInt(100000, 999999)}`,
    openaiCallId: null,
    goal,
    chatJid,
    direction: 'outbound',
    controlWs: null,
    transcript: [],
    uasDialog: null,
    uacDialog: null,
  };
  activeCalls.set(callId, state);

  try {
    // Early Offer via UDP: OpenAI first, then Sipgate with plain RTP SDP
    const { pstnDialog, openaiDialog } = await buildOutboundEarlyOfferUDP(
      state,
      to,
    );
    state.uacDialog = pstnDialog;
    state.uasDialog = openaiDialog;
  } catch (err: any) {
    const status = err?.status;
    logger.error({ callId, status, err: err?.message }, 'Outbound call failed');

    let reason = 'Anruf fehlgeschlagen';
    if (status === 486 || status === 600) reason = 'Besetzt';
    else if (status === 480 || status === 408) reason = 'Keine Antwort';
    else if (status === 603) reason = 'Abgelehnt';
    else if (status === 487) reason = 'Abgebrochen';

    if (voiceDeps && chatJid) {
      voiceDeps
        .sendMessage(chatJid, `📞 ${reason} (${status || 'Fehler'})`)
        .catch(() => {});
    }
    cleanupCall(callId);
  }
}

/** Early Offer via UDP: OpenAI first, then Sipgate with plain RTP SDP.
 *
 * UDP registration = no SRTP enforcement. Plain RTP on Sipgate side.
 * Late Offer doesn't work with Sipgate/UDP (200 OK contains no SDP).
 *
 * Flow:
 * 1. Synthetic plain RTP offer → rtpengine → SRTP SDP for OpenAI
 * 2. INVITE OpenAI with SRTP SDP
 * 3. rtpengine answer(OpenAI SDP) → plain RTP SDP for Sipgate
 * 4. INVITE Sipgate WITH plain RTP SDP (Early Offer, UDP)
 * 5. Sipgate answers — NO re-offer, asymmetric latching
 */
async function buildOutboundEarlyOfferUDP(
  state: SipgateCallState,
  to: string,
): Promise<{ pstnDialog: any; openaiDialog: any }> {
  const { callId, sipCallId, fromTag } = state;

  // Step 1: Synthetic plain RTP offer to rtpengine.
  // from-tag = Sipgate side. Plain RTP (no crypto needed with UDP registration).
  const syntheticSdp = [
    'v=0',
    `o=- ${Date.now()} 0 IN IP4 ${HETZNER_PUBLIC_IP}`,
    's=-',
    `c=IN IP4 ${HETZNER_PUBLIC_IP}`,
    't=0 0',
    'm=audio 10000 RTP/AVP 8 101',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    'a=sendrecv',
    'a=ptime:20',
    '',
  ].join('\r\n');

  logger.info(
    { callId },
    'Early Offer UDP: synthetic plain RTP offer to rtpengine',
  );
  const offerRes: any = await rtpEngine.offer({
    'call-id': sipCallId,
    'from-tag': fromTag,
    sdp: syntheticSdp,
    ICE: 'remove',
    DTLS: 'off',
    SDES: 'on',
    flags: ['asymmetric'],
    replace: ['origin', 'session-connection'],
    direction: ['external', 'external'],
    'transport-protocol': 'RTP/SAVP',
  });
  if (offerRes?.result !== 'ok') {
    throw new Error(`rtpengine offer failed: ${offerRes?.['error-reason']}`);
  }

  // Step 2: INVITE OpenAI with SRTP SDP from rtpengine
  const sdpForOpenAI = cleanSdpForOpenAI(offerRes.sdp as string);
  logger.info(
    { callId, sdpForOpenAI },
    'Sending INVITE to OpenAI with SRTP SDP',
  );

  // Register webhook handler BEFORE sending INVITE
  const webhookPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOpenAIWebhook.delete(callId);
      reject(new Error('OpenAI webhook timeout (15s)'));
    }, 15000);
    pendingOpenAIWebhook.set(callId, {
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

  const openaiDialog: any = await (srf as any).createUAC(OPENAI_SIP_URI, {
    localSdp: sdpForOpenAI,
    headers: { 'User-Agent': 'NanoClaw/1.0' },
  });
  state.uasDialog = openaiDialog;

  const openaiSdp: string = openaiDialog.remote?.sdp || '';
  const toTag: string =
    openaiDialog.sip?.remoteTag ||
    openaiDialog.remote?.tag ||
    `oai-${crypto.randomInt(100000, 999999)}`;
  logger.info({ callId, openaiSdp }, 'OpenAI answered');

  // Step 3: rtpengine answer — get plain RTP SDP for Sipgate
  const answerRes: any = await rtpEngine.answer({
    'call-id': sipCallId,
    'from-tag': fromTag,
    'to-tag': toTag,
    sdp: openaiSdp,
    ICE: 'remove',
    DTLS: 'off',
    flags: ['asymmetric'],
    replace: ['origin', 'session-connection'],
    direction: ['external', 'external'],
    'transport-protocol': 'RTP/AVP',
  });
  if (answerRes?.result !== 'ok') {
    throw new Error(`rtpengine answer failed: ${answerRes?.['error-reason']}`);
  }

  const sdpForSipgate = cleanSdpAnswer(answerRes.sdp as string);
  logger.info(
    { callId, sdpForSipgate },
    'Early Offer UDP: INVITE Sipgate with plain RTP SDP',
  );

  // Step 4: INVITE Sipgate with Early Offer (SDP in INVITE, UDP)
  // Use sipgate.de (not sip.sipgate.de) — only sipgate.de responds on UDP.
  const sipUri = `sip:${to}@${SIP_DOMAIN};transport=udp`;
  const pstnDialog: any = await (srf as any).createUAC(
    sipUri,
    {
      localSdp: sdpForSipgate,
      headers: {
        From: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        Contact: `<sip:${SIP_USER}@${HETZNER_PUBLIC_IP}:5060>`,
        'P-Preferred-Identity': `<sip:+49308687022345@${SIP_DOMAIN}>`,
      },
      auth: { username: SIP_USER, password: SIP_PASSWORD },
    },
    {
      cbRequest: (req: any) => {
        state._inviteReq = req;
        logger.info({ callId }, 'Early Offer UDP INVITE sent to sipgate');
      },
      cbProvisional: (provisionalRes: any) => {
        const status = provisionalRes?.status || provisionalRes?.msg?.status;
        logger.info({ callId, status }, 'Provisional response from sipgate');
        if (status === 180 && voiceDeps && state.chatJid) {
          voiceDeps
            .sendMessage(state.chatJid, '📞 Klingelt...')
            .catch(() => {});
        }
      },
    },
  );
  state.uacDialog = pstnDialog;

  // Step 5: Sipgate answered — re-offer with their real SDP so rtpengine
  // knows where to send RTP packets. This is safe with plain RTP (no SRTP
  // crypto renegotiation). The previous SRTP re-offer broke OpenAI's leg,
  // but plain RTP re-offer should be transparent to the OpenAI side.
  const sipgateRealSdp: string = pstnDialog.remote?.sdp || '';
  logger.info(
    { callId, sipgateRealSdp },
    'Sipgate answered — re-offer with real SDP (plain RTP, safe)',
  );
  if (sipgateRealSdp) {
    const reofferRes: any = await rtpEngine.offer({
      'call-id': sipCallId,
      'from-tag': fromTag,
      sdp: sipgateRealSdp,
      ICE: 'remove',
      DTLS: 'off',
      flags: ['asymmetric'],
      replace: ['origin', 'session-connection'],
      direction: ['external', 'external'],
      'transport-protocol': 'RTP/SAVP',
    });
    if (reofferRes?.result !== 'ok') {
      logger.warn(
        { err: reofferRes?.['error-reason'] },
        'rtpengine re-offer failed (non-fatal)',
      );
    } else {
      logger.info({ callId }, 'rtpengine updated with Sipgate real SDP');
    }
  }

  // Trigger RTP latching on both legs with staggered timing.
  // OpenAI leg first (500ms), Sipgate leg delayed (2s) to avoid collision
  // with the first real packets from OpenAI being forwarded.
  triggerRtpLatching(sipCallId, fromTag, callId);

  // Wait for webhook handler to accept the OpenAI call
  await webhookPromise;

  // NOW trigger Andy's greeting — Sipgate has answered, media path is ready.
  // 1s delay lets playMedia latching finish before real audio flows.
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
      logger.info(
        { callId },
        'Outbound greeting sent (after Sipgate answered)',
      );
    }
  }, 1000);

  // Wire up hangup handlers
  pstnDialog.on('destroy', () => {
    logger.info({ callId }, 'PSTN callee hung up');
    try {
      openaiDialog.destroy();
    } catch {
      /* already ended */
    }
    cleanupCall(callId);
  });
  openaiDialog.on('destroy', () => {
    logger.info({ callId }, 'OpenAI side hung up');
    try {
      pstnDialog.destroy();
    } catch {
      /* already ended */
    }
    cleanupCall(callId);
  });

  return { pstnDialog, openaiDialog };
}

// --- SIP Registration with Sipgate ---

let registerInterval: ReturnType<typeof setInterval> | null = null;

async function registerWithSipgate(): Promise<void> {
  if (!srf) return;

  try {
    // Register via UDP — Sipgate does NOT enforce SRTP for UDP-registered devices.
    // This eliminates the SRTP bridging problem entirely.
    const req = await (srf as any).request({
      uri: `sip:${SIP_DOMAIN};transport=udp`,
      method: 'REGISTER',
      headers: {
        To: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        From: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        Contact: `<sip:${SIP_USER}@${HETZNER_PUBLIC_IP}:5060>`,
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
      uri: `sip:${SIP_DOMAIN};transport=udp`,
      method: 'REGISTER',
      headers: {
        To: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        From: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        Contact: `<sip:${SIP_USER}@${HETZNER_PUBLIC_IP}:5060>`,
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
  repeatTimes = '1',
  duration = '200',
): void {
  if (!rtpEngine) return;

  const playOpts = {
    'call-id': sipCallId,
    'from-tag': fromTag,
    file: '/media/silence.wav',
    'repeat-times': repeatTimes,
    duration,
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

  // Short delay, then play into OpenAI leg (to-tag side)
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

  const goal = `Incoming call from ${from} — answer and help the caller`;

  const state: SipgateCallState = {
    callId,
    sipCallId,
    fromTag,
    openaiCallId: null,
    goal,
    chatJid: '',
    direction: 'inbound',
    controlWs: null,
    transcript: [],
    uasDialog: null,
    uacDialog: null,
  };

  // Notify main group
  if (voiceDeps) {
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
    // rtpengine bridges SRTP (Sipgate/TLS) ↔ SRTP (OpenAI) via Hetzner
    const sipgateSdp = req.body as string;
    logger.info(
      { callId, target: OPENAI_SIP_URI },
      'Bridging to OpenAI SIP via B2BUA + rtpengine',
    );

    if (!rtpEngine) {
      throw new Error('rtpengine not initialized');
    }

    // Offer to rtpengine: Sipgate's SDP → SRTP for OpenAI.
    // With UDP registration, Sipgate may send plain RTP — need SDES: 'on'
    // so rtpengine generates crypto keys for the OpenAI side.
    const offerRes: any = await rtpEngine.offer({
      'call-id': sipCallId,
      'from-tag': fromTag,
      sdp: sipgateSdp,
      ICE: 'remove',
      DTLS: 'off',
      SDES: 'on',
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

    const cleanSdp = cleanSdpForOpenAI(offerRes.sdp as string);
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
        // Answer back to Sipgate: match their offer transport.
        // With UDP registration, Sipgate sends plain RTP. With TLS, SRTP.
        const sipgateProto = sipgateSdp.includes('RTP/SAVP')
          ? 'RTP/SAVP'
          : 'RTP/AVP';
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
          'transport-protocol': sipgateProto,
        });
        if (answerRes?.result !== 'ok') {
          logger.error(
            { err: answerRes?.['error-reason'] },
            'rtpengine answer failed',
          );
          return sdp;
        }
        logger.info({ callId }, 'rtpengine answer OK');
        return cleanSdpAnswer(answerRes.sdp as string);
      },
    });

    state.uasDialog = uas;
    state.uacDialog = uac;

    logger.info({ callId }, 'B2BUA bridge established: Sipgate ↔ OpenAI');

    // Trigger Sipgate's RTP latching: both Sipgate and OpenAI use symmetric RTP
    // (wait for incoming before sending). rtpengine sits in between but generates
    // no traffic by itself → deadlock. playMedia injects silence RTP from
    // rtpengine's allocated ports, which triggers latching on both sides.
    // Inbound needs longer latching than outbound (no re-offer), but keep it short
    triggerRtpLatching(sipCallId, fromTag, callId, '2', '500');

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
        {
          openaiCallId,
          activeCalls: [...activeCalls.keys()],
          pendingOutbound: [...pendingOpenAIWebhook.keys()],
        },
        'Incoming call webhook — searching for matching active call',
      );

      // Check outbound calls waiting for webhook first — accept immediately
      // (OpenAI blocks SIP 200 OK until we call accept via REST API)
      for (const [key, pending] of pendingOpenAIWebhook) {
        logger.info(
          { callId: key, openaiCallId },
          'Matched webhook to pending outbound call — accepting',
        );
        pending.state.openaiCallId = openaiCallId;
        pendingOpenAIWebhook.delete(key);
        res.status(200).send('OK');
        // Accept + connect WS, then resolve the Promise so buildOpenAILeg can continue
        acceptOpenAICall(openaiCallId, pending.state)
          .then(() => pending.resolve())
          .catch((err) => pending.reject(err));
        return;
      }

      // Fall through to inbound matching
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
          'Matched OpenAI webhook to active inbound call — accepting',
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

  // rtpengine runs on Hetzner (public IP, no WireGuard hop for RTP media)
  const RTPENGINE_HOST = '10.0.0.1';
  const rtpUtils = RtpEngineClient([`${RTPENGINE_HOST}:22222`]);
  rtpEngine = rtpUtils.getRtpEngine();
  logger.info(
    { host: RTPENGINE_HOST },
    'rtpengine client initialized (Hetzner)',
  );

  // drachtio stays on Lenovo1 (TLS support needed for OpenAI SIP)
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
    'Sipgate voice initialized (UDP/RTP → OpenAI Native SIP)',
  );
}
