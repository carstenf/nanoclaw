import dgram from 'dgram';
import crypto from 'crypto';
import os from 'os';
import { WebSocket } from 'ws';
import Srf from 'drachtio-srf';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile([
  'SIPGATE_SIP_URI',
  'SIPGATE_SIP_PASSWORD',
  'SIPGATE_TOKEN_ID',
  'SIPGATE_TOKEN',
  'HINDSIGHT_LLM_API_KEY',
  'OPENAI_REALTIME_VOICE',
]);

const SIP_USER = env.SIPGATE_SIP_URI?.replace(/^sip:/, '').split('@')[0] || '';
const SIP_DOMAIN = env.SIPGATE_SIP_URI?.replace(/^sip:/, '').split('@')[1] || 'sipgate.de';
const SIP_PASSWORD = env.SIPGATE_SIP_PASSWORD || '';
const SIPGATE_TOKEN_ID = env.SIPGATE_TOKEN_ID || '';
const SIPGATE_TOKEN = env.SIPGATE_TOKEN || '';
const OPENAI_API_KEY = env.HINDSIGHT_LLM_API_KEY || '';
const REALTIME_VOICE = env.OPENAI_REALTIME_VOICE || 'coral';

// Device ID for the SIP user (e0 = first VoIP phone)
const DEVICE_ID = 'e0';

// RTP port range for media (inside NanoClaw's 4400-4499 range)
const RTP_PORT_MIN = 4440;
const RTP_PORT_MAX = 4460;
let nextRtpPort = RTP_PORT_MIN;

interface SipgateCallState {
  callId: string;
  goal: string;
  chatJid: string;
  direction: 'inbound' | 'outbound';
  rtpSocket: dgram.Socket | null;
  rtpPort: number;
  remoteRtpHost: string | null;
  remoteRtpPort: number | null;
  openaiWs: WebSocket | null;
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
  dialog: Srf.Dialog | null;
  codec: number; // 0=PCMU, 8=PCMA
}

const activeCalls = new Map<string, SipgateCallState>();
let srf: InstanceType<typeof Srf> | null = null;

export interface SipgateVoiceDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

let voiceDeps: SipgateVoiceDeps | null = null;

// --- SDP helpers ---

function allocateRtpPort(): number {
  const port = nextRtpPort;
  nextRtpPort = nextRtpPort >= RTP_PORT_MAX ? RTP_PORT_MIN : nextRtpPort + 2; // RTP uses even ports
  return port;
}

function buildSdp(localIp: string, rtpPort: number): string {
  return [
    'v=0',
    `o=nanoclaw ${Date.now()} ${Date.now()} IN IP4 ${localIp}`,
    's=NanoClaw Sipgate Voice',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP 8`,  // 8=PCMA (alaw) — European standard
    'a=rtpmap:8 PCMA/8000',
    'a=ptime:20',
    'a=sendrecv',
  ].join('\r\n') + '\r\n';
}

function parseSdpMedia(sdp: string): { host: string; port: number; codec: number } | null {
  const cMatch = sdp.match(/c=IN IP4 (\S+)/);
  const mMatch = sdp.match(/m=audio (\d+) RTP\/AVP (.+)/);
  if (!cMatch || !mMatch) return null;
  const host = cMatch[1];
  const port = parseInt(mMatch[1], 10);
  // Pick first codec — prefer PCMA (8) for European telephony
  const codecs = mMatch[2].split(/\s+/).map(Number);
  const codec = codecs.includes(8) ? 8 : codecs[0];
  return { host, port, codec };
}

// --- RTP handling ---

function createRtpSocket(port: number): dgram.Socket {
  const socket = dgram.createSocket('udp4');
  socket.bind(port, '0.0.0.0');
  return socket;
}

// RTP header: 12 bytes minimum
// Byte 0: V=2, P, X, CC
// Byte 1: M, PT
// Bytes 2-3: Sequence number
// Bytes 4-7: Timestamp
// Bytes 8-11: SSRC
const RTP_HEADER_SIZE = 12;

function buildRtpPacket(payload: Buffer, sequenceNumber: number, timestamp: number, ssrc: number, payloadType: number): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE);
  header[0] = 0x80; // V=2
  header[1] = payloadType & 0x7f;
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

// --- OpenAI Realtime connection ---

function connectOpenAI(state: SipgateCallState): void {
  logger.info({ callId: state.callId, hasApiKey: !!OPENAI_API_KEY }, 'Connecting to OpenAI Realtime (sipgate)');
  const ws = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    },
  );

  state.openaiWs = ws;

  // RTP sending state
  let seq = 0;
  let ts = 0;
  const ssrc = crypto.randomInt(0, 0xffffffff);
  const payloadType = 8; // PCMA (alaw) — fixed for European telephony

  // RTP pacing queue: send packets at 20ms intervals
  const rtpQueue: Buffer[] = [];
  let rtpTimer: ReturnType<typeof setInterval> | null = null;

  function startRtpPacer(): void {
    if (rtpTimer) return;
    rtpTimer = setInterval(() => {
      const chunk = rtpQueue.shift();
      if (chunk && state.rtpSocket && state.remoteRtpHost && state.remoteRtpPort) {
        const packet = buildRtpPacket(chunk, seq++, ts, ssrc, payloadType);
        ts += 160; // 20ms at 8kHz
        state.rtpSocket.send(packet, state.remoteRtpPort, state.remoteRtpHost);
      }
      if (rtpQueue.length === 0 && rtpTimer) {
        clearInterval(rtpTimer);
        rtpTimer = null;
      }
    }, 20); // 20ms = one RTP frame
  }

  ws.on('open', () => {
    logger.info({ callId: state.callId }, 'OpenAI Realtime connected (sipgate)');

    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: `You are Andy, a personal assistant making a phone call on behalf of Carsten (Munich, Germany).
Goal: ${state.goal}

Critical call etiquette:
- Do NOT speak first. Wait for the other person to say something (like "Hallo").
- If you hear silence for more than 3 seconds, say "Hallo?" to confirm someone is on the line, then wait for a response.
- Only after the other person has spoken, introduce yourself and state your purpose.
- Respond in the same language the other person uses (default: German)
- Keep responses short — one or two sentences at a time
- Be natural, warm, and conversational
- When the goal is achieved, say a natural goodbye and stop responding`,
        voice: REALTIME_VOICE,
        input_audio_format: 'g711_alaw',
        output_audio_format: 'g711_alaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 200,
          silence_duration_ms: 700,
        },
      },
    }));

    // No auto-greeting — wait for the callee to speak first
    // OpenAI VAD will detect when they say "Hallo" and respond
  });

  ws.on('message', (data: Buffer) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case 'response.audio.delta': {
        // Queue audio for paced RTP delivery (20ms per frame)
        const audioB64 = event.delta as string;
        if (!audioB64) return;

        const audioPayload = Buffer.from(audioB64, 'base64');
        // Split into 160-byte chunks (20ms at 8kHz G.711)
        const chunkSize = 160;
        for (let i = 0; i < audioPayload.length; i += chunkSize) {
          const chunk = audioPayload.subarray(i, Math.min(i + chunkSize, audioPayload.length));
          rtpQueue.push(Buffer.from(chunk)); // copy to avoid subarray issues
        }
        startRtpPacer();
        break;
      }

      case 'input_audio_buffer.speech_started':
        // Barge-in: clear pending audio when user starts speaking
        rtpQueue.length = 0;
        if (rtpTimer) {
          clearInterval(rtpTimer);
          rtpTimer = null;
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text) {
            state.transcript.push({ role: 'user', text });
            logger.debug({ callId: state.callId, text }, 'Sipgate user transcript');
          }
        }
        break;

      case 'response.audio_transcript.done':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text) {
            state.transcript.push({ role: 'assistant', text });
            logger.debug({ callId: state.callId, text }, 'Sipgate assistant transcript');
          }
        }
        break;

      case 'error':
        logger.error({ callId: state.callId, error: event.error }, 'OpenAI Realtime error (sipgate)');
        break;
    }
  });

  ws.on('error', (err) => {
    logger.error({ callId: state.callId, err }, 'OpenAI Realtime WebSocket error (sipgate)');
  });

  ws.on('close', () => {
    if (rtpTimer) { clearInterval(rtpTimer); rtpTimer = null; }
    rtpQueue.length = 0;
    logger.info({ callId: state.callId }, 'OpenAI Realtime WebSocket closed (sipgate)');
  });
}

// --- RTP listener: forward caller audio to OpenAI ---

function startRtpListener(state: SipgateCallState): void {
  if (!state.rtpSocket) return;
  logger.info({ callId: state.callId, rtpPort: state.rtpPort }, 'RTP listener started');

  let rtpPacketCount = 0;
  state.rtpSocket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    rtpPacketCount++;
    if (rtpPacketCount === 1) {
      // Read actual payload type from RTP header byte 1 (lower 7 bits)
      const actualPT = msg[1] & 0x7f;
      logger.info({ callId: state.callId, from: `${rinfo.address}:${rinfo.port}`, size: msg.length, payloadType: actualPT, codecName: actualPT === 8 ? 'PCMA/alaw' : 'PCMU/ulaw' }, 'First RTP packet received');
      // Learn actual remote endpoint
      state.remoteRtpHost = rinfo.address;
      state.remoteRtpPort = rinfo.port;
      state.codec = actualPT;
    }
    if (msg.length < RTP_HEADER_SIZE) return;

    // Extract RTP payload (skip 12-byte header)
    const payload = msg.subarray(RTP_HEADER_SIZE);
    if (!payload.length) return;

    // Learn remote RTP endpoint from first packet
    // (some providers send from a different port than advertised in SDP)
    if (!state.remoteRtpHost || !state.remoteRtpPort) {
      const info = state.rtpSocket!.remoteAddress?.();
      // We'll set remote from SDP instead — see parseSdpMedia
    }

    // Forward to OpenAI
    if (state.openaiWs?.readyState === WebSocket.OPEN) {
      state.openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: payload.toString('base64'),
      }));
    }
  });
}

// --- Call cleanup ---

function cleanupCall(callId: string): void {
  const state = activeCalls.get(callId);
  if (!state) return;

  if (state.openaiWs?.readyState === WebSocket.OPEN) {
    state.openaiWs.close();
  }
  if (state.rtpSocket) {
    try { state.rtpSocket.close(); } catch { /* ignore */ }
  }
  if (state.dialog) {
    try { state.dialog.destroy(); } catch { /* ignore */ }
  }

  // Send transcript summary
  if (voiceDeps) {
    const summary = buildSummary(state);
    voiceDeps.sendMessage(state.chatJid, summary).catch((err) => {
      logger.error({ err, callId }, 'Failed to send sipgate call summary');
    });
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

// --- Local IP detection ---

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// --- Public API ---

// Pending outbound calls: when we trigger via REST API, sipgate calls our
// registered SIP device first. We store the goal/chatJid here so the inbound
// INVITE handler can pick them up.
const pendingOutbound = new Map<string, { goal: string; chatJid: string; to: string }>();

export async function makeSipgateCall(
  to: string,
  goal: string,
  chatJid: string,
): Promise<void> {
  if (!SIPGATE_TOKEN_ID || !SIPGATE_TOKEN) {
    throw new Error('Sipgate API token not configured');
  }

  // Store pending call context — the inbound INVITE handler will use this
  pendingOutbound.set(to, { goal, chatJid, to });

  // sipgate REST API: initiate call
  // This rings our registered device (e0) first, then connects to callee
  const auth = Buffer.from(`${SIPGATE_TOKEN_ID}:${SIPGATE_TOKEN}`).toString('base64');

  logger.info({ to, goal, deviceId: DEVICE_ID }, 'Initiating sipgate outbound call via REST API');

  try {
    const response = await fetch('https://api.sipgate.com/v2/sessions/calls', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        callee: to,
        caller: SIP_USER ? `${SIP_USER}` : undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.info({ status: response.status, body, to }, 'SIPGATE REST API CALL FAILED');
      pendingOutbound.delete(to);
      throw new Error(`Sipgate API error ${response.status}: ${body}`);
    }

    const result = await response.json() as { sessionId?: string };
    logger.info({ sessionId: result.sessionId, to }, 'Sipgate outbound call initiated via REST API');

    // The call flow is:
    // 1. sipgate rings our SIP device (e0) — we auto-answer as inbound INVITE
    // 2. sipgate then dials the callee
    // 3. Audio flows through our SIP device — we bridge it to OpenAI

    // Timeout: if no inbound INVITE arrives within 30s, clean up
    setTimeout(() => {
      if (pendingOutbound.has(to)) {
        pendingOutbound.delete(to);
        logger.warn({ to }, 'Sipgate outbound call timed out waiting for SIP INVITE');
      }
    }, 30000);

  } catch (err: any) {
    logger.info({ message: err?.message, to }, 'SIPGATE OUTBOUND CALL ERROR');
    pendingOutbound.delete(to);
    throw err;
  }
}

export function startSipgateVoice(deps: SipgateVoiceDeps): void {
  if (!SIP_USER || !SIP_PASSWORD) {
    logger.warn('Sipgate not configured — sipgate voice not started');
    return;
  }

  voiceDeps = deps;
  srf = new Srf();

  srf.connect({ host: '127.0.0.1', port: 9022, secret: 'cymru' });

  srf.on('connect', (_err: Error, hostPort: string) => {
    logger.info({ hostPort }, 'Connected to drachtio-server for sipgate');

    // Register with sipgate as a SIP endpoint
    logger.info('Attempting SIP registration with sipgate...');
    registerWithSipgate().catch((err) => {
      logger.error({ err }, 'registerWithSipgate threw');
    });
  });

  srf.on('error', (err: Error) => {
    logger.error({ err }, 'drachtio-srf connection error');
  });

  srf.on('disconnect', () => {
    logger.warn('Disconnected from drachtio-server, will reconnect');
  });

  // Handle incoming calls
  srf.invite((req: Srf.SrfRequest, res: Srf.SrfResponse) => {
    handleInboundCall(req, res);
  });

  logger.info('Sipgate voice module initialized');
}

// --- SIP Registration ---

let registerInterval: ReturnType<typeof setInterval> | null = null;

async function registerWithSipgate(): Promise<void> {
  if (!srf) return;

  const localIp = getLocalIp();
  logger.info({ localIp, sipUser: SIP_USER, sipDomain: SIP_DOMAIN }, 'SIP REGISTER params');
  try {
    const req = await (srf as any).request({
      uri: `sip:${SIP_DOMAIN}`,
      method: 'REGISTER',
      headers: {
        'To': `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        'From': `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
        'Contact': `<sip:${SIP_USER}@${localIp}:5060>`,
        'Expires': '300',
      },
    } as any);
    logger.info('SIP REGISTER request object received');

    // Handle 401 challenge with digest auth
    (req as any).on('response', (res: any) => {
      if (res.status === 200) {
        logger.info('SIP REGISTER successful with sipgate');
      } else if (res.status === 401 || res.status === 407) {
        logger.info({ status: res.status }, 'SIP REGISTER challenge received, authenticating...');
        // drachtio-srf digest-client handles 401 automatically for createUAC,
        // but for raw requests we need to re-send with credentials
        handleRegisterChallenge(res, localIp);
      } else {
        logger.warn({ status: res.status, reason: res.reason }, 'SIP REGISTER unexpected response');
      }
    });

    logger.info('SIP REGISTER sent to sipgate');

    // Re-register every 4 minutes (only set once)
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

function handleRegisterChallenge(res: any, localIp: string): void {
  if (!srf) return;

  const authHeader = res.get('www-authenticate') || res.get('proxy-authenticate');
  if (!authHeader) {
    logger.error('No auth challenge header in 401 response');
    return;
  }

  // Parse challenge
  const realmMatch = authHeader.match(/realm="([^"]+)"/);
  const nonceMatch = authHeader.match(/nonce="([^"]+)"/);
  if (!realmMatch || !nonceMatch) {
    logger.error('Could not parse auth challenge');
    return;
  }

  const realm = realmMatch[1];
  const nonce = nonceMatch[1];

  // Compute digest response
  const ha1 = crypto.createHash('md5').update(`${SIP_USER}:${realm}:${SIP_PASSWORD}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`REGISTER:sip:${SIP_DOMAIN}`).digest('hex');
  const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');

  const authValue = `Digest username="${SIP_USER}", realm="${realm}", nonce="${nonce}", uri="sip:${SIP_DOMAIN}", response="${response}", algorithm=MD5`;

  (srf as any).request({
    uri: `sip:${SIP_DOMAIN}`,
    method: 'REGISTER',
    headers: {
      'To': `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
      'From': `<sip:${SIP_USER}@${SIP_DOMAIN}>`,
      'Contact': `<sip:${SIP_USER}@${localIp}:5060>`,
      'Expires': '300',
      'Authorization': authValue,
    },
  } as any).then((req2: any) => {
    (req2 as any).on('response', (res2: any) => {
      if (res2.status === 200) {
        logger.info('SIP REGISTER authenticated successfully with sipgate');
      } else {
        logger.error({ status: res2.status, reason: res2.reason }, 'SIP REGISTER auth failed');
      }
    });
  }).catch((err: any) => {
    logger.error({ err }, 'SIP REGISTER auth request failed');
  });
}

// --- Inbound call handler ---

async function handleInboundCall(req: Srf.SrfRequest, res: Srf.SrfResponse): Promise<void> {
  const callId = `sg-in-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
  const from = req.callingNumber || 'unknown';
  const to = req.calledNumber || 'unknown';
  const rtpPort = allocateRtpPort();
  const rtpSocket = createRtpSocket(rtpPort);
  const localIp = getLocalIp();

  logger.info({ callId, from, to, uri: req.uri }, 'Incoming sipgate SIP INVITE');

  // Check if this is a pending outbound call (REST API triggered)
  // sipgate rings our device first, then connects to the callee
  let pendingCall: { goal: string; chatJid: string; to: string } | undefined;
  for (const [key, pending] of pendingOutbound.entries()) {
    pendingCall = pending;
    pendingOutbound.delete(key);
    break; // Take the first pending call
  }

  const isOutbound = !!pendingCall;
  const goal = pendingCall?.goal || `Incoming call from ${from} — answer and help the caller`;
  const chatJid = pendingCall?.chatJid || '';

  const state: SipgateCallState = {
    callId,
    goal,
    chatJid,
    direction: isOutbound ? 'outbound' : 'inbound',
    rtpSocket,
    rtpPort,
    remoteRtpHost: null,
    remoteRtpPort: null,
    openaiWs: null,
    transcript: [],
    dialog: null,
    codec: 0, // default PCMU, updated from SDP
  };

  // Parse caller's SDP
  const remoteSdp = req.sdp || '';
  const media = parseSdpMedia(remoteSdp);
  if (media) {
    state.remoteRtpHost = media.host;
    state.remoteRtpPort = media.port;
    state.codec = media.codec;
    logger.info({ callId, remoteRtp: `${media.host}:${media.port}`, codec: media.codec, codecName: media.codec === 8 ? 'PCMA/alaw' : 'PCMU/ulaw' }, 'Remote RTP endpoint parsed');
  }

  activeCalls.set(callId, state);

  try {
    const localSdp = buildSdp(localIp, rtpPort);
    const dialog = await srf!.createUAS(req, res, { localSdp });

    state.dialog = dialog;
    logger.info({ callId, isOutbound }, 'Sipgate call answered (UAS dialog created)');

    // Notify about call
    if (voiceDeps && !isOutbound) {
      state.chatJid = 'main';
      void voiceDeps.sendMessage(state.chatJid, `Eingehender Sipgate-Anruf von ${from}`);
    }

    // Start audio bridge
    startRtpListener(state);
    connectOpenAI(state);

    dialog.on('destroy', () => {
      logger.info({ callId, from, isOutbound }, 'Sipgate call ended');
      cleanupCall(callId);
    });

  } catch (err: any) {
    logger.info({ callId, errMsg: err?.message || String(err) }, 'Failed to answer sipgate call');
    cleanupCall(callId);
  }
}
