import crypto from 'crypto';
import OpenAI from 'openai';
import { WebSocket } from 'ws';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { renderVoiceInstructions } from './voice-instructions.js';

const env = readEnvFile([
  'OPENAI_SIP_API_KEY',
  'HINDSIGHT_LLM_API_KEY',
  'OPENAI_REALTIME_VOICE',
  'OPENAI_PROJECT_ID',
  'VOICE_SIDECAR_URL',
]);

const OPENAI_API_KEY =
  env.OPENAI_SIP_API_KEY || env.HINDSIGHT_LLM_API_KEY || '';
const DEFAULT_VOICE = env.OPENAI_REALTIME_VOICE || 'shimmer';
const PROJECT_ID = env.OPENAI_PROJECT_ID || '';
const SIDECAR_URL = env.VOICE_SIDECAR_URL || 'http://10.0.0.1:4500';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
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
  /** Recording file path on Hetzner for Whisper transcription */
  recordingFile: string;
  /**
   * Outbound only: the dialed phone number in E.164 form, used by the
   * openai-webhook handler to correlate the OpenAI realtime.call.incoming
   * webhook with this pending outbound call (instead of FIFO matching,
   * which races with concurrent SIP-spam scanner traffic).
   */
  to: string;
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

/**
 * The `end_call` function tool. The model decides when to call this; the
 * application listens for it on the WS and tears down the call. This is the
 * declarative replacement for the old auto-prompt timer logic.
 */
const END_CALL_TOOL = {
  type: 'function' as const,
  name: 'end_call',
  description:
    'End the current phone call cleanly. Call this when the conversation is done, ' +
    'when nobody is answering after a few greetings, or when the other person declines.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: ['completed', 'no_answer', 'declined', 'error'],
        description:
          'Why the call is ending: completed = normal end, no_answer = silence after greetings, declined = caller refused, error = something went wrong.',
      },
    },
    required: ['reason'],
  },
};

/**
 * Public wrapper around acceptOpenAICall, exported so the openai-webhook
 * handler can call accept directly when matching a pending outbound. The
 * webhook handler must call accept synchronously (not delegate back to
 * makeFreeswitchCall) because the originate command in makeFreeswitchCall
 * is blocked waiting for OpenAI's SIP 200 OK, which OpenAI only sends
 * after we've called accept via the API.
 */
export async function acceptOpenAICallForOutbound(
  openaiCallId: string,
  state: FSCallState,
): Promise<void> {
  return acceptOpenAICall(openaiCallId, state);
}

async function acceptOpenAICall(
  openaiCallId: string,
  state: FSCallState,
): Promise<void> {
  logger.info(
    { callId: state.callId, openaiCallId, goal: state.goal },
    'FS: Accepting call via OpenAI Realtime API',
  );

  try {
    // Instructions are loaded fresh from voice/SKILL.md every call, so the
    // user can edit Andy's behaviour without rebuilding. Persona is pulled
    // from groups/<group>/CLAUDE.md so the phone Andy stays consistent with
    // the chat Andy.
    const groupName =
      state.chatJid && state.chatJid.length > 0 ? 'main' : 'main';
    const instructions = renderVoiceInstructions({
      direction: state.direction,
      group: groupName,
      goal: state.goal,
    });

    await openai.realtime.calls.accept(openaiCallId, {
      type: 'realtime',
      model: 'gpt-realtime',
      instructions,
      audio: {
        input: {
          turn_detection: {
            type: 'server_vad',
            // Threshold lowered from 0.5 to 0.3 because cellular voice goes
            // through GSM/AMR compression → Sipgate transcode to G.711 PCMA
            // → reduced signal level. With 0.5 (default for studio audio)
            // VAD never fired speech_started for real mobile callers, only
            // for synthesized voicemail prompts. 0.3 is a common telephony
            // setting that catches normal cellular speech without being so
            // sensitive that line noise triggers false positives.
            threshold: 0.3,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
            // idle_timeout_ms = OpenAI auto-triggers a model response after
            // this much silence. Critical for outbound calls where the callee
            // never speaks: without this Andy stays mute forever. The
            // SKILL.md instructions tell Andy what to do when this fires
            // (greet, then end_call after a few attempts).
            idle_timeout_ms: 5000,
          },
          transcription: { model: 'whisper-1' },
        },
        output: { voice: state.voice },
      },
      tools: [END_CALL_TOOL],
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
  // GA Realtime API: NO OpenAI-Beta header (Beta is being deprecated 2026-05-07).
  // Model selection happens at session creation via openai.realtime.calls.accept().
  // The `origin` header is required by OpenAI for SIP-bridged control WS connections;
  // without it the handshake succeeds but no events are emitted (silent failure).
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${openaiCallId}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        origin: 'https://api.openai.com',
      },
    },
  );

  state.controlWs = ws;

  // Declarative behaviour: voice/SKILL.md tells Andy what to do.
  // - Inbound: Andy greets first because the SKILL.md instructions tell him to.
  // - Outbound: Andy waits for the callee to speak first (per the SKILL.md
  //   instructions). If nobody speaks he says "Hallo?" a few times and then
  //   calls the `end_call` function tool with reason='no_answer'.
  // - Mid-call silence: same — Andy decides via instructions, no app-level timer.
  ws.on('open', () => {
    logger.info({ callId: state.callId }, 'FS: Control WebSocket connected');
    if (state.direction === 'inbound') {
      // Kick off the first response. The text comes from voice/SKILL.md
      // (rendered into session.instructions during accept), so Andy says
      // exactly what we configured there without us re-stating it here.
      ws.send(JSON.stringify({ type: 'response.create' }));
      logger.info({ callId: state.callId }, 'FS: Inbound greeting triggered');
    } else {
      // Outbound: do NOT send response.create. Andy waits for the callee to
      // speak first. VAD picks up the speech, then OpenAI auto-responds based
      // on the SKILL.md instructions. If nobody speaks Andy will follow the
      // silence-handling steps in SKILL.md and end the call via `end_call`.
      logger.info(
        { callId: state.callId },
        'FS: Outbound WS open — waiting for callee speech (declarative flow)',
      );
    }
  });

  ws.on('message', (data: Buffer) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Log event types (skip noisy ones — input_audio_buffer fires per
    // RTP packet, delta events fire per audio chunk, both are way too
    // chatty for normal operation).
    const eventType = event.type as string;
    if (
      !eventType?.includes('input_audio_buffer') &&
      !eventType?.includes('delta')
    ) {
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
        // Nothing app-level to do — the model decides when to respond next
        // based on VAD + the SKILL.md instructions. App used to maintain a
        // greeting/silence state machine here; that's now Andy's job.
        break;

      // --- Function tool handling: end_call ---
      case 'response.function_call_arguments.done':
      case 'response.output_function_call_arguments.done': {
        const name = event.name as string | undefined;
        const argsRaw = (event.arguments as string) || '{}';
        if (name === 'end_call') {
          let reason = 'completed';
          try {
            const parsed = JSON.parse(argsRaw) as { reason?: string };
            if (parsed.reason) reason = parsed.reason;
          } catch {
            // ignore parse errors, default reason stands
          }
          logger.info(
            { callId: state.callId, reason },
            'FS: end_call tool invoked by model',
          );
          // Give Andy enough time to finish the verbal goodbye that runs in
          // the response immediately before the tool call. 1.5s was too short
          // — it cut him off mid-sentence. 4s leaves room for a natural
          // "Tschuess, schoenen Tag noch, auf Wiederhoeren" plus a beat.
          const t = setTimeout(() => cleanupCall(state.callId), 4000);
          state.timers.push(t);
        }
        break;
      }

      case 'response.output_audio_transcript.done':
        // Andy's own utterance — log only. Goodbye detection is now Andy's
        // job: per voice/SKILL.md he calls `end_call` himself when the
        // conversation is done.
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text && state.transcript.length < MAX_TRANSCRIPT_TURNS) {
            state.transcript.push({ role: 'assistant', text });
            logger.info({ callId: state.callId, text }, 'FS: Andy said');
          }
        }
        break;

      // --- Transcript handlers ---
      case 'conversation.item.input_audio_transcription.completed':
        // Caller's utterance — log only. Goodbye detection is Andy's job too.
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text && state.transcript.length < MAX_TRANSCRIPT_TURNS) {
            state.transcript.push({ role: 'user', text });
            logger.info({ callId: state.callId, text }, 'FS: Caller said');
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

  // Post-call Whisper transcription (async, don't block cleanup)
  const chatJid = state.chatJid || 'dc:1490365616518070407';
  if (state.recordingFile) {
    transcribeRecording(state.recordingFile, state.callId, chatJid).catch(
      (err) => {
        logger.error(
          { callId, err: err?.message },
          'FS: Whisper transcription failed',
        );
      },
    );
  }

  logger.info({ callId }, 'FS: Call state cleaned up');
}

/**
 * Full teardown: close WebSocket, kill FS channel, then clean up state.
 */
function cleanupCall(callId: string): void {
  const state = activeCalls.get(callId);
  if (!state) return;

  // Tell OpenAI to end the SIP call. Required for inbound calls where
  // FreeSWITCH handles the bridge via dialplan and we have no fsUuid to
  // hang up directly — without this the OpenAI side keeps the call open
  // even after we close the control WebSocket.
  if (state.openaiCallId) {
    openai.realtime.calls.hangup(state.openaiCallId).catch((err: any) => {
      logger.warn(
        { callId, openaiCallId: state.openaiCallId, err: err?.message },
        'FS: openai.realtime.calls.hangup failed (probably already ended)',
      );
    });
  }

  if (state.controlWs?.readyState === WebSocket.OPEN) {
    state.controlWs.close();
  }

  // Kill the FreeSWITCH channel if we tracked it directly (outbound case).
  if (state.fsUuid) {
    sidecarHangup(state.fsUuid).catch(() => {});
  }

  cleanupCallState(callId);
}

const HETZNER_RECORDINGS_URL = 'https://mcp.carstenfreek.de/recordings';

async function transcribeRecording(
  recFile: string,
  callId: string,
  chatJid: string,
): Promise<void> {
  // Wait 5s for FS to flush the recording file
  await new Promise((r) => setTimeout(r, 5000));

  let filename: string;
  if (recFile === 'inbound') {
    // Inbound: find the most recent inbound-*.wav via Caddy JSON listing
    const dirResp = await fetch(HETZNER_RECORDINGS_URL + '/', {
      headers: { Accept: 'application/json' },
    });
    if (!dirResp.ok) {
      logger.warn(
        { callId, status: dirResp.status },
        'FS: Cannot list recordings directory',
      );
      return;
    }
    const listing = (await dirResp.json()) as Array<{
      name: string;
      mod_time: string;
      size: number;
    }>;
    const inboundFiles = listing
      .filter((f) => f.name.startsWith('inbound-') && f.name.endsWith('.wav'))
      .sort(
        (a, b) =>
          new Date(b.mod_time).getTime() - new Date(a.mod_time).getTime(),
      );

    if (inboundFiles.length === 0) {
      logger.warn({ callId }, 'FS: No inbound recording found');
      return;
    }
    filename = inboundFiles[0].name; // most recently modified
    logger.info(
      { callId, filename, modTime: inboundFiles[0].mod_time },
      'FS: Found inbound recording',
    );
  } else {
    filename = recFile.split('/').pop() || '';
  }
  const url = `${HETZNER_RECORDINGS_URL}/${filename}`;

  logger.info({ callId, url }, 'FS: Downloading recording for transcription');

  // Download WAV from Hetzner (via Caddy)
  const resp = await fetch(url);
  if (!resp.ok) {
    logger.warn(
      { callId, status: resp.status },
      'FS: Recording download failed',
    );
    return;
  }
  const wavBuffer = Buffer.from(await resp.arrayBuffer());
  logger.info({ callId, size: wavBuffer.length }, 'FS: Recording downloaded');

  // Send to Whisper API
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([wavBuffer], { type: 'audio/wav' }),
    filename,
  );
  formData.append('model', 'whisper-1');
  formData.append('language', 'de');

  const whisperResp = await fetch(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    },
  );

  if (!whisperResp.ok) {
    logger.warn(
      { callId, status: whisperResp.status },
      'FS: Whisper transcription failed',
    );
    return;
  }

  const result = (await whisperResp.json()) as { text: string };
  const transcript = result.text?.trim();

  if (transcript && voiceDeps) {
    logger.info(
      { callId, transcriptLen: transcript.length },
      'FS: Whisper transcript ready',
    );
    try {
      voiceDeps
        .sendMessage(chatJid, `📝 Transkript:\n${transcript}`)
        .catch(() => {});
    } catch {
      /* channel not connected */
    }
  }
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

  // Pre-flight health check
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
    controlWs: null,
    transcript: [],
    timers: [],
    recordingFile: '',
    to, // dialed E.164 number — used by webhook matcher to avoid spam-stealing the slot
  };
  activeCalls.set(callId, state);

  try {
    // ──────────────────────────────────────────────────────────────────
    // PRE-BRIDGE OUTBOUND FLOW
    //
    // Goal: by the time the user picks up their phone, the OpenAI Realtime
    // session is already fully established (SIP-bridged, WS open). User
    // hears Andy ready immediately, no awkward 7-second silence.
    //
    // Flow:
    //   1. Originate FS→OpenAI directly. Tag the SIP INVITE with a custom
    //      X-Nanoclaw-CallId header so the webhook can be correlated back
    //      to this call regardless of caller-id heuristics.
    //   2. Park the resulting OpenAI leg.
    //   3. Wait for the OpenAI webhook → openai-webhook handler matches by
    //      header → calls accept() → opens the control WebSocket.
    //   4. Once WS is open and "session.created" has fired, originate the
    //      user-leg via Sipgate, bridging it directly to the parked
    //      OpenAI leg via &bridge(<openai_uuid>).
    //   5. User answers → instant audio with Andy. No silence wait.
    //
    // Compared to the old flow (originate user → park → uuid_transfer to
    // openai dialplan), this front-loads the ~7 seconds of OpenAI SIP
    // processing into the time WHILE the user's phone is ringing rather
    // than AFTER they picked up.
    // ──────────────────────────────────────────────────────────────────

    // Register webhook listener BEFORE the originate so we don't miss the
    // racing webhook reply.
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

    // Step 1: Originate FS→OpenAI directly (B-leg only).
    // The X-Nanoclaw-CallId header is the correlation key the webhook
    // handler uses to match this call. origination_caller_id_number is
    // set so OpenAI's `From` header is recognizable in logs (kept in
    // sync with what we used to set on the gateway leg).
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

    // Step 2: Wait for OpenAI's webhook → openai-webhook handler calls
    // acceptOpenAICall() → OpenAI sends SIP 200 OK to FreeSWITCH → the
    // pre-bridge originate command above completes and returns +OK.
    // The handler resolves this promise only AFTER accept finished, so by
    // the time webhookPromise resolves, the SIP leg is fully established
    // and acceptOpenAICall has spawned the control WS.
    //
    // (Order in real time is interleaved: the originate await and the
    // webhookPromise await unblock at roughly the same moment because
    // they're both gated on the same accept() call running in parallel.)
    await webhookPromise;
    logger.info(
      { callId, openaiCallId: state.openaiCallId },
      'FS: OpenAI webhook matched + accept done — pre-bridge ready',
    );

    // Step 3: Wait for the control WebSocket to actually be OPEN before
    // dialing the user. acceptOpenAICall() spawns connectControlWs which
    // opens the WS asynchronously — usually within ~500ms after accept
    // returns. The WS being OPEN is our signal that OpenAI Realtime is
    // ready to receive audio from the bridge.
    {
      const wsDeadline = Date.now() + 5000;
      while (
        (!state.controlWs || state.controlWs.readyState !== WebSocket.OPEN) &&
        Date.now() < wsDeadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!state.controlWs || state.controlWs.readyState !== WebSocket.OPEN) {
        await sidecarApi(`uuid_kill ${openaiUuid}`).catch(() => {});
        throw new Error('Control WebSocket did not open within 5s');
      }
    }
    logger.info(
      { callId, openaiUuid },
      'FS: OpenAI control WS is open — bridge ready, dialing user',
    );

    // Step 4: Originate user via Sipgate. We use &park() to wait for the
    // user to answer, then issue uuid_bridge to connect the two legs.
    //
    // Why not `&bridge(${openaiUuid})`? FreeSWITCH's bridge() application
    // expects a dial-string (e.g., sofia/gateway/...), NOT a UUID. Trying
    // to pass a UUID gives CHAN_NOT_IMPLEMENTED. The correct way to bridge
    // an existing leg to a newly-answered call is the uuid_bridge API
    // command after both UUIDs exist.
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
      // Clean up the parked OpenAI leg if the user-originate fails
      await sidecarApi(`uuid_kill ${openaiUuid}`).catch(() => {});
      throw new Error(`User originate failed: ${userResult}`);
    }
    const userUuid = userResult.replace('+OK ', '').trim();
    state.fsUuid = userUuid;
    logger.info(
      { callId, userUuid, openaiUuid },
      'FS: User answered (parked), bridging to OpenAI leg',
    );

    // Bridge the two legs. Audio flows immediately.
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

    // Step 5: Recording on the user-leg (captures both directions of the bridge)
    const recFile = `/recordings/${callId}.wav`;
    state.recordingFile = recFile;
    await sidecarApi(`uuid_record ${userUuid} start ${recFile}`);
    logger.info(
      { callId, userUuid, openaiUuid, recFile },
      'FS: User-leg established and bridged to OpenAI, recording started',
    );

    // Tag the user channel for hangup tracking
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
    recordingFile: 'inbound', // marker — actual file found by timestamp after call
    to: '', // not applicable for inbound
  };

  // Set chat JID for transcript delivery (Discord preferred)
  if (voiceDeps) {
    const mainJid = voiceDeps.getMainJid();
    state.chatJid = mainJid || 'dc:1490365616518070407';
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

// --- Sidecar SSE connection ---

let sseAbort: AbortController | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSseReconnect(): void {
  if (sseReconnectTimer) return;
  sidecarReady = false;
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = null;
    connectSidecarSse();
  }, 5000);
}

async function connectSidecarSse(): Promise<void> {
  // First verify sidecar is healthy
  const healthy = await checkSidecarHealth();
  if (!healthy) {
    logger.warn(
      { url: SIDECAR_URL },
      'FS: Sidecar not healthy, retrying in 5s',
    );
    scheduleSseReconnect();
    return;
  }

  sidecarReady = true;
  logger.info({ url: SIDECAR_URL }, 'FS: Sidecar healthy, connecting SSE');

  sseAbort = new AbortController();
  try {
    const resp = await fetch(`${SIDECAR_URL}/events`, {
      signal: sseAbort.signal,
    });

    if (!resp.ok || !resp.body) {
      logger.warn({ status: resp.status }, 'FS: SSE connection failed');
      scheduleSseReconnect();
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    logger.info('FS: SSE stream connected');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6)) as {
            event: string;
            uuid: string;
            caller?: string;
            destination?: string;
            hangupCause?: string;
          };

          if (event.event === 'CHANNEL_HANGUP_COMPLETE') {
            // Find active call by fsUuid and clean up
            for (const [callId, state] of activeCalls) {
              if (state.fsUuid === event.uuid) {
                logger.info(
                  { callId, cause: event.hangupCause },
                  'FS: Channel hangup via SSE',
                );
                cleanupCall(callId);
                break;
              }
            }
          }
        } catch {
          /* skip malformed SSE lines */
        }
      }
    }

    // Stream ended normally
    logger.warn('FS: SSE stream ended, reconnecting in 5s');
    scheduleSseReconnect();
  } catch (err: any) {
    if (err?.name === 'AbortError') return; // intentional close
    logger.error({ err: err?.message }, 'FS: SSE connection error');
    scheduleSseReconnect();
  }
}

// --- Public API ---

export function startFreeswitchVoice(deps: FreeswitchVoiceDeps): void {
  voiceDeps = deps;

  if (!PROJECT_ID) {
    logger.warn('OPENAI_PROJECT_ID not set — FreeSWITCH voice not started');
    return;
  }

  connectSidecarSse();
  logger.info(
    { sidecar: SIDECAR_URL },
    'FS: FreeSWITCH voice initialized via sidecar (webhook via openai-webhook on 4402)',
  );
}
