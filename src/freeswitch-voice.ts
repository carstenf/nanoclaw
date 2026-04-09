import crypto from 'crypto';
import OpenAI from 'openai';
import { WebSocket } from 'ws';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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
  let outboundTimersCancelled = false; // true once outbound greeting timers are cancelled
  /** Outbound greeting timers — tracked separately so they can be cancelled on first speech */
  const outboundTimers: ReturnType<typeof setTimeout>[] = [];

  function cancelOutboundTimers(): void {
    if (outboundTimersCancelled) return;
    outboundTimersCancelled = true;
    for (const t of outboundTimers) clearTimeout(t);
    // Also remove them from state.timers
    for (const t of outboundTimers) {
      const idx = state.timers.indexOf(t);
      if (idx !== -1) state.timers.splice(idx, 1);
    }
    outboundTimers.length = 0;
    logger.info(
      { callId: state.callId },
      'FS: Outbound greeting timers cancelled',
    );
  }

  ws.on('open', () => {
    logger.info({ callId: state.callId }, 'FS: Control WebSocket connected');

    if (state.direction === 'inbound') {
      // Inbound: greet immediately (caller expects Andy to answer)
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: { type: 'realtime', turn_detection: null },
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Greet the caller in German. Say: "Hallo, hier ist Andy, wie kann ich helfen?"',
              },
            ],
          },
        }),
      );
      ws.send(JSON.stringify({ type: 'response.create' }));
      greetingSent = true;
      logger.info(
        { callId: state.callId },
        'FS: Inbound greeting sent immediately',
      );
    } else {
      // Outbound: wait for callee to speak (VAD enabled).
      // If silent after 1s → "Hallo? Ist da jemand?" via conversation.item.create
      logger.info(
        { callId: state.callId },
        'FS: Outbound — waiting for callee, 1s fallback timer set',
      );

      const t1 = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN || greetingSent) return;
        greetingSent = true;
        // Disable VAD briefly to send the hallo
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: { type: 'realtime', turn_detection: null },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'Say only: "Hallo? Ist da jemand?"',
                },
              ],
            },
          }),
        );
        ws.send(JSON.stringify({ type: 'response.create' }));
        logger.info({ callId: state.callId }, 'FS: Hallo attempt 1 (1s)');
      }, 1000);

      const t2 = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN || outboundTimersCancelled) return;
        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Say only: "Hallo?"' }],
            },
          }),
        );
        ws.send(JSON.stringify({ type: 'response.create' }));
        logger.info({ callId: state.callId }, 'FS: Hallo attempt 2 (4s)');
      }, 4000);

      const t3 = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN || outboundTimersCancelled) return;
        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Say only: "Hallo?"' }],
            },
          }),
        );
        ws.send(JSON.stringify({ type: 'response.create' }));
        logger.info({ callId: state.callId }, 'FS: Hallo attempt 3 (7s)');
      }, 7000);

      const tHangup = setTimeout(() => {
        if (outboundTimersCancelled) return;
        logger.info(
          { callId: state.callId },
          'FS: No response after 3 attempts, hanging up',
        );
        cleanupCall(state.callId);
      }, 10000);

      outboundTimers.push(t1, t2, t3, tHangup);
      state.timers.push(t1, t2, t3, tHangup);
    }
  });

  let silenceCheckActive = false;

  // Mid-call silence timer: silence → "Hallo?" series → hangup
  function startSilenceTimer() {
    // Clear any existing silence timers
    for (const t of state.timers) clearTimeout(t);
    state.timers.length = 0;
    silenceCheckActive = true;

    const s1 = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // No VAD toggle needed — metadata.source identifies our silence checks
      ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Say only: "Hallo? Bist du noch da?"',
              },
            ],
          },
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'response.create',
          response: { metadata: { source: 'silence_check' } },
        }),
      );
      logger.info({ callId: state.callId }, 'FS: Silence check 1 (1s)');
    }, 1000);

    const s2 = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Say only: "Hallo?"' }],
          },
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'response.create',
          response: { metadata: { source: 'silence_check' } },
        }),
      );
      logger.info({ callId: state.callId }, 'FS: Silence check 2 (4s)');
    }, 4000);

    const s3 = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Say only: "Hallo?"' }],
          },
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'response.create',
          response: { metadata: { source: 'silence_check' } },
        }),
      );
      logger.info({ callId: state.callId }, 'FS: Silence check 3 (7s)');
    }, 7000);

    const sHangup = setTimeout(() => {
      logger.info(
        { callId: state.callId },
        'FS: No response after silence checks, hanging up',
      );
      cleanupCall(state.callId);
    }, 10000);

    state.timers.push(s1, s2, s3, sHangup);
  }

  ws.on('message', (data: Buffer) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Log event types (skip noisy ones)
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

      case 'response.done': {
        const resp = event.response as Record<string, unknown> | undefined;
        const isSilenceCheck =
          (resp?.metadata as Record<string, unknown>)?.source ===
          'silence_check';

        // First response: mark conversation as started, cancel outbound timers
        if (!conversationStarted && !isSilenceCheck) {
          conversationStarted = true;
          cancelOutboundTimers();
        }

        if (!isSilenceCheck) {
          // Re-enable VAD after greeting / real responses (was disabled via session.update)
          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                },
                input_audio_transcription: { model: 'whisper-1' },
              },
            }),
          );
          logger.info(
            { callId: state.callId },
            'FS: VAD re-enabled after response',
          );
        } else {
          logger.info(
            { callId: state.callId },
            'FS: Silence check response done (no VAD toggle)',
          );
        }
        break;
      }

      case 'output_audio_buffer.started':
        // Andy started speaking — only cancel timers if NOT from our silence check
        if (!silenceCheckActive) {
          for (const t of state.timers) clearTimeout(t);
          state.timers.length = 0;
        }
        break;

      case 'output_audio_buffer.cleared':
        // User interrupted Andy — cancel silence timers, reset silence check
        silenceCheckActive = false;
        for (const t of state.timers) clearTimeout(t);
        state.timers.length = 0;
        break;

      case 'response.output_audio.done':
        // Audio GENERATION complete — playback may still be ongoing.
        // Don't start silence timer here.
        break;

      case 'output_audio_buffer.stopped':
        // Audio PLAYBACK finished — the listener has heard Andy's last word.
        logger.info(
          { callId: state.callId, silenceCheckActive },
          'FS: Audio playback finished (output_audio_buffer.stopped)',
        );
        // Only start NEW silence timer if not already in a silence check sequence
        if (conversationStarted && !silenceCheckActive) {
          startSilenceTimer();
        }
        break;

      case 'input_audio_buffer.speech_started':
        if (!conversationStarted) conversationStarted = true;
        if (silenceCheckActive) {
          // During silence check: VAD may pick up echo of Andy's own
          // "Hallo?" audio. Don't cancel timers yet — wait for actual
          // transcription (transcription.completed) to confirm real speech.
          break;
        }
        cancelOutboundTimers();
        for (const t of state.timers) clearTimeout(t);
        state.timers.length = 0;
        break;

      case 'input_audio_buffer.speech_stopped':
        // Only restart silence timer outside of a silence check sequence
        // (otherwise echo from Andy's "Hallo?" resets the sequence endlessly)
        if (!silenceCheckActive) {
          startSilenceTimer();
        }
        break;

      case 'response.audio_transcript.done': {
        // Check for goodbye → auto-hangup after 2s
        const transcript = ((event.transcript as string) || '').toLowerCase();
        const goodbyeWords = [
          'tschüs',
          'tschüss',
          'auf wiedersehen',
          'auf wiederhören',
          'bye',
          'ciao',
          'goodbye',
        ];
        if (goodbyeWords.some((w) => transcript.includes(w))) {
          logger.info(
            { callId: state.callId },
            'FS: Goodbye detected, hanging up in 2s',
          );
          const goodbyeTimer = setTimeout(
            () => cleanupCall(state.callId),
            2000,
          );
          state.timers.push(goodbyeTimer);
        }
        // Transcript logging (existing)
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text && state.transcript.length < MAX_TRANSCRIPT_TURNS) {
            state.transcript.push({ role: 'assistant', text });
            logger.info({ callId: state.callId, text }, 'FS: Andy said');
          }
        }
        break;
      }

      // --- Transcript handlers ---
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          const text = (event.transcript as string).trim();
          if (text) {
            // Real speech confirmed — exit silence check if active
            if (silenceCheckActive) {
              silenceCheckActive = false;
              for (const t of state.timers) clearTimeout(t);
              state.timers.length = 0;
              logger.info(
                { callId: state.callId },
                'FS: Silence check cancelled — user spoke',
              );
            }
          }
          if (text && state.transcript.length < MAX_TRANSCRIPT_TURNS) {
            state.transcript.push({ role: 'user', text });
            logger.info({ callId: state.callId, text }, 'FS: Caller said');
            // Check caller goodbye too
            const callerText = text.toLowerCase();
            const byeWords = [
              'tschüs',
              'tschüss',
              'auf wiedersehen',
              'auf wiederhören',
              'bye',
              'ciao',
              'goodbye',
            ];
            if (byeWords.some((w) => callerText.includes(w))) {
              logger.info(
                { callId: state.callId },
                'FS: Caller goodbye detected, hanging up in 3s',
              );
              const byeTimer = setTimeout(
                () => cleanupCall(state.callId),
                3000,
              );
              state.timers.push(byeTimer);
            }
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

  if (state.controlWs?.readyState === WebSocket.OPEN) {
    state.controlWs.close();
  }

  // Kill the FreeSWITCH channel if still alive
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
  };
  activeCalls.set(callId, state);

  try {
    // Step 1: Originate call to Sipgate, park the channel
    const originateArgs = `{origination_caller_id_number=+49308687022346,origination_caller_id_name=Andy,hangup_after_bridge=true}sofia/gateway/sipgate/${to} &park()`;

    const result = await sidecarApi(`originate ${originateArgs}`);
    if (!result.startsWith('+OK')) {
      throw new Error(`Originate failed: ${result}`);
    }
    const uuid = result.replace('+OK ', '').trim();

    state.fsUuid = uuid;
    // Start recording for post-call Whisper transcription
    const recFile = `/recordings/${callId}.wav`;
    state.recordingFile = recFile;
    await sidecarApi(`uuid_record ${uuid} start ${recFile}`);
    logger.info(
      { callId, uuid, recFile },
      'FS: Call answered, recording started',
    );

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
    await sidecarApi(`uuid_setvar ${uuid} openai_project_id ${PROJECT_ID}`);
    const transferCmd = `uuid_transfer ${uuid} openai XML public`;
    logger.info({ callId, transferCmd }, 'FS: Transferring to OpenAI bridge');
    const transferResult = await sidecarApi(transferCmd);
    logger.info(
      { callId, result: transferResult.trim() },
      'FS: Transfer result',
    );

    // Step 4: Wait for OpenAI webhook (resolved by openai-webhook handler)
    await webhookPromise;

    // Step 4b: Accept the OpenAI call (webhook set the openaiCallId on state)
    if (state.openaiCallId) {
      await acceptOpenAICall(state.openaiCallId, state);
    }

    // Step 5: Tag channel for hangup tracking
    await sidecarApi(`uuid_setvar ${uuid} nanoclaw_call_id ${callId}`);
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
