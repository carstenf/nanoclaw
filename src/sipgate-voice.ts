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
    // For outbound calls, trigger greeting immediately since Andy initiates.
    // For inbound, let VAD handle naturally — caller speaks first.
    if (state.direction === 'outbound') {
      ws.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Greet the person and explain why you are calling. Your goal: ${state.goal}`,
          },
        }),
      );
    }
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
  const sipUri = `sip:${to}@sip.${SIP_DOMAIN};transport=tls`;

  logger.info({ callId, to, goal, sipUri }, 'Initiating direct SIP INVITE to sipgate');

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

  // Application-level timeout: cancel INVITE if callee doesn't answer
  let inviteReq: any = null;
  const timeoutId = setTimeout(() => {
    if (inviteReq) {
      try { inviteReq.cancel(); } catch { /* ignore */ }
    }
  }, 45000);

  try {
    // Phase 1: Direct SIP INVITE to sipgate trunk
    const uacResult: any = await (srf as any).createUAC(sipUri, {
      noAck: true,
      headers: {
        From: `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        Contact: `<sip:${SIP_USER}@${HETZNER_PUBLIC_IP}:5061;transport=tls>`,
        'P-Preferred-Identity': `<sip:+49308687022345@${SIP_DOMAIN}>`,
      },
      auth: { username: SIP_USER, password: SIP_PASSWORD },
    }, {
      cbRequest: (req: any) => {
        inviteReq = req;
        logger.info({ callId }, 'INVITE sent to sipgate');
      },
      cbProvisional: (provisionalRes: any) => {
        const status = provisionalRes?.status || provisionalRes?.msg?.status;
        logger.info({ callId, status }, 'Provisional response from sipgate');
        if (status === 180 && voiceDeps && chatJid) {
          voiceDeps.sendMessage(chatJid, '📞 Klingelt...').catch(() => {});
        }
      },
    });
    clearTimeout(timeoutId);

    // 3PCC: callee answered (200 OK) — we have their SDP but haven't ACKed
    const calleeSdp: string = uacResult.sdp;
    logger.info({ callId, sdpLen: calleeSdp.length }, 'Callee answered — building OpenAI leg');

    // Phase 2: Build OpenAI leg via rtpengine, then ACK the PSTN leg
    const pstnDialog = await buildOpenAILeg(state, calleeSdp, uacResult.ack);
    state.uacDialog = pstnDialog;

  } catch (err: any) {
    clearTimeout(timeoutId);
    const status = err?.status;
    logger.error({ callId, status, err: err?.message }, 'Outbound call failed');

    let reason = 'Anruf fehlgeschlagen';
    if (status === 486 || status === 600) reason = 'Besetzt';
    else if (status === 480 || status === 408) reason = 'Keine Antwort';
    else if (status === 603) reason = 'Abgelehnt';
    else if (status === 487) reason = 'Abgebrochen';

    if (voiceDeps && chatJid) {
      voiceDeps.sendMessage(chatJid, `📞 ${reason} (${status || 'Fehler'})`).catch(() => {});
    }
    cleanupCall(callId);
  }
}

/** Phase 2: rtpengine offer → INVITE OpenAI → rtpengine answer → ACK PSTN */
async function buildOpenAILeg(
  state: SipgateCallState,
  calleeSdp: string,
  ackPstn: (sdp: string) => Promise<any>,
): Promise<any> {
  const { callId, sipCallId, fromTag } = state;

  // rtpengine offer: callee's SDP (plain RTP/AVP) → get SDP for OpenAI (SDES-SRTP)
  // Use DTLS:off — OpenAI uses SDES (not DTLS). Setting DTLS:passive would make
  // rtpengine expect a DTLS handshake on the Sipgate leg which never comes,
  // causing rtpengine to receive packets but never forward them.
  // SDES:on generates crypto lines that OpenAI can negotiate with.
  const offerRes: any = await rtpEngine.offer({
    'call-id': sipCallId,
    'from-tag': fromTag,
    sdp: calleeSdp,
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

  // Strip bad crypto suites and DTLS attrs; OpenAI uses SDES only for outbound
  const sdpForOpenAI = cleanSdpForOpenAI(offerRes.sdp as string);
  logger.info({ callId, sdpLen: sdpForOpenAI.length }, 'rtpengine offer OK — sending INVITE to OpenAI');

  // Register webhook handler BEFORE sending INVITE (webhook can arrive immediately).
  // The webhook handler will call acceptOpenAICall directly — OpenAI blocks
  // the SIP 200 OK until we accept via REST API, so createUAC would deadlock
  // if we tried to accept after it returns.
  const webhookPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOpenAIWebhook.delete(callId);
      reject(new Error('OpenAI webhook timeout (15s)'));
    }, 15000);
    pendingOpenAIWebhook.set(callId, {
      state,
      resolve: () => { clearTimeout(timeout); resolve(); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });
  });

  // INVITE OpenAI SIP with rtpengine's SDP
  logger.info({ callId, sdpForOpenAI }, 'Sending INVITE to OpenAI with SDP');
  const openaiDialog: any = await (srf as any).createUAC(OPENAI_SIP_URI, {
    localSdp: sdpForOpenAI,
    headers: {
      'User-Agent': 'NanoClaw/1.0',
    },
  });
  state.uasDialog = openaiDialog;

  // rtpengine answer: OpenAI's SDP → get SDP for PSTN ACK
  const openaiSdp: string = openaiDialog.remote?.sdp || '';
  logger.info({ callId, openaiSdp }, 'OpenAI response SDP');
  const toTag: string =
    openaiDialog.sip?.remoteTag ||
    openaiDialog.remote?.tag ||
    `oai-${crypto.randomInt(100000, 999999)}`;

  // Sipgate outbound uses plain RTP/AVP, OpenAI uses SRTP/SAVP.
  // rtpengine bridges: decrypt SRTP from OpenAI, send plain RTP to Sipgate.
  // TODO: Sipgate might require SRTP even for outbound — see OUTBOUND-AUDIO-ANALYSIS.md
  // Need to generate SDES keys in the OFFER phase for the Sipgate side.
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
    logger.error({ err: answerRes?.['error-reason'] }, 'rtpengine answer failed');
  }

  // ACK the PSTN leg with rtpengine's answer SDP
  const sdpForPstn = cleanSdpAnswer(answerRes.sdp as string);
  logger.info({ callId, sdpForPstn, calleeSdp }, 'ACKing PSTN with rtpengine SDP');
  const pstnDialog = await ackPstn(sdpForPstn);
  logger.info({ callId }, 'B2BUA bridge established: PSTN ↔ rtpengine ↔ OpenAI');

  // Trigger RTP latching for outbound.
  // For outbound, play silence into the OpenAI leg immediately (latches that side).
  // For the Sipgate leg, delay playMedia by 2s — Sipgate needs time to send its
  // first RTP packet (triggered by the callee speaking). If we play into the
  // Sipgate leg too early, MASQUERADE conntrack on Hetzner collides with the
  // DNAT rule and blocks all forwarded packets.
  // The 2s delay allows Sipgate's first packet to establish the DNAT conntrack
  // entry first, so subsequent MASQUERADE traffic follows the same path.
  triggerRtpLatchingOutbound(sipCallId, fromTag, callId);

  // Wait for webhook handler to accept the OpenAI call
  // (accept happens in the webhook handler to avoid SIP deadlock)
  await webhookPromise;

  // Wire up hangup handlers
  pstnDialog.on('destroy', () => {
    logger.info({ callId }, 'PSTN callee hung up');
    try { openaiDialog.destroy(); } catch { /* already ended */ }
    cleanupCall(callId);
  });
  openaiDialog.on('destroy', () => {
    logger.info({ callId }, 'OpenAI side hung up');
    try { pstnDialog.destroy(); } catch { /* already ended */ }
    cleanupCall(callId);
  });

  return pstnDialog;
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
 * Outbound-specific latching: OpenAI leg immediately, Sipgate leg after 2s delay.
 * The delay lets Sipgate's first RTP packet arrive via DNAT and establish a
 * conntrack entry. Only then do we inject silence into the Sipgate leg —
 * at that point MASQUERADE reuses the existing conntrack instead of creating
 * a conflicting one.
 */
function triggerRtpLatchingOutbound(
  sipCallId: string,
  fromTag: string,
  callId: string,
): void {
  if (!rtpEngine) return;

  // Immediately play into OpenAI leg (to-tag side)
  setTimeout(() => {
    rtpEngine
      .query({ 'call-id': sipCallId, 'from-tag': fromTag })
      .then((qRes: any) => {
        const toTag = qRes?.tags
          ? Object.keys(qRes.tags).find((t: string) => t !== fromTag)
          : null;
        if (toTag) {
          rtpEngine
            .playMedia({
              'call-id': sipCallId,
              'from-tag': toTag,
              file: '/media/silence.wav',
              'repeat-times': '3',
              duration: '1000',
            })
            .then((res: any) => {
              logger.info({ callId, result: res?.result }, 'playMedia → OpenAI leg (outbound)');
            })
            .catch((err: any) => {
              logger.warn({ callId, err: err?.message }, 'playMedia → OpenAI leg failed');
            });
        }
      })
      .catch((err: any) => {
        logger.warn({ callId, err: err?.message }, 'rtpengine query for to-tag failed');
      });
  }, 500);

  // Delayed play into Sipgate leg (from-tag side) — wait for DNAT conntrack
  setTimeout(() => {
    rtpEngine
      .playMedia({
        'call-id': sipCallId,
        'from-tag': fromTag,
        file: '/media/silence.wav',
        'repeat-times': '3',
        duration: '1000',
      })
      .then((res: any) => {
        logger.info({ callId, result: res?.result }, 'playMedia → Sipgate leg (outbound, delayed 2s)');
      })
      .catch((err: any) => {
        logger.warn({ callId, err: err?.message }, 'playMedia → Sipgate leg failed');
      });
  }, 2000);
}

/**
 * Play silence only into the OpenAI leg — for outbound calls.
 * Sipgate uses plain RTP and sends immediately after ACK.
 * Playing media into the Sipgate leg BEFORE Sipgate sends its first packet
 * creates a MASQUERADE conntrack entry on Hetzner that collides with the
 * DNAT rule, causing all subsequent forwarded packets to be invisible.
 */
function triggerRtpLatchingOpenAIOnly(
  sipCallId: string,
  fromTag: string,
  callId: string,
): void {
  if (!rtpEngine) return;

  // Small delay to let rtpengine discover the to-tag, then play into OpenAI leg
  setTimeout(() => {
    rtpEngine
      .query({ 'call-id': sipCallId, 'from-tag': fromTag })
      .then((qRes: any) => {
        const toTag = qRes?.tags
          ? Object.keys(qRes.tags).find((t: string) => t !== fromTag)
          : null;
        if (toTag) {
          rtpEngine
            .playMedia({
              'call-id': sipCallId,
              'from-tag': toTag,
              file: '/media/silence.wav',
              'repeat-times': '3',
              duration: '1000',
            })
            .then((res: any) => {
              logger.info({ callId, result: res?.result }, 'playMedia → OpenAI leg only');
            })
            .catch((err: any) => {
              logger.warn({ callId, err: err?.message }, 'playMedia → OpenAI leg failed');
            });
        }
      })
      .catch((err: any) => {
        logger.warn({ callId, err: err?.message }, 'rtpengine query for to-tag failed');
      });
  }, 500);
}

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
        { openaiCallId, activeCalls: [...activeCalls.keys()], pendingOutbound: [...pendingOpenAIWebhook.keys()] },
        'Incoming call webhook — searching for matching active call',
      );

      // Check outbound calls waiting for webhook first — accept immediately
      // (OpenAI blocks SIP 200 OK until we call accept via REST API)
      for (const [key, pending] of pendingOpenAIWebhook) {
        logger.info({ callId: key, openaiCallId }, 'Matched webhook to pending outbound call — accepting');
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
