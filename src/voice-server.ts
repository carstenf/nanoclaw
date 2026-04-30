import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import twilio from 'twilio';
import OpenAI from 'openai';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile([
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'VOICE_PUBLIC_URL',
  'VOICE_SERVER_PORT',
  'HINDSIGHT_LLM_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'VOICE_MODE',
  'OPENAI_REALTIME_VOICE',
]);

const PORT = parseInt(env.VOICE_SERVER_PORT || '4401', 10);
const PUBLIC_URL = env.VOICE_PUBLIC_URL;
const ACCOUNT_SID = env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = env.TWILIO_FROM_NUMBER;
const VOICE_MODE = env.VOICE_MODE || 'relay'; // 'relay' or 'realtime'
const REALTIME_VOICE = env.OPENAI_REALTIME_VOICE || 'coral';

const VoiceResponse = twilio.twiml.VoiceResponse;

interface CallState {
  goal: string;
  chatJid: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentLanguage: string;
  voiceMode: 'relay' | 'realtime';
}

// Detect spoken language from transcribed text
function detectLanguage(text: string): string {
  const t = text.toLowerCase();
  const score: Record<string, number> = {
    'de-DE': 0,
    'it-IT': 0,
    'en-US': 0,
    'fr-FR': 0,
    'es-ES': 0,
  };

  const patterns: Array<[string, RegExp]> = [
    [
      'it-IT',
      /\b(ciao|grazie|prego|buongiorno|buonasera|pronto|sì|va bene|come|sono|signor|signora|capito|perfetto|certamente)\b/,
    ],
    [
      'de-DE',
      /\b(danke|bitte|hallo|guten|ja|nein|ich|sie|auf wiederhören|natürlich|genau|entschuldigung|moment|schön)\b/,
    ],
    [
      'fr-FR',
      /\b(bonjour|bonsoir|merci|oui|non|je|vous|s'il vous plaît|d'accord|bien sûr|monsieur|madame)\b/,
    ],
    [
      'es-ES',
      /\b(hola|gracias|sí|buenos días|buenas|por favor|claro|señor|señora|de nada|como)\b/,
    ],
    [
      'en-US',
      /\b(hello|hi|thank you|thanks|yes|no|please|good morning|good afternoon|of course|sure|great|okay)\b/,
    ],
  ];

  for (const [lang, pattern] of patterns) {
    const matches = t.match(pattern);
    if (matches) score[lang] += matches.length;
  }

  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'de-DE';
}

const activeCalls = new Map<string, CallState>();

export interface VoiceDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export async function makeCall(
  to: string,
  goal: string,
  chatJid: string,
  voiceMode?: string,
): Promise<void> {
  const mode =
    voiceMode === 'relay' || voiceMode === 'realtime' ? voiceMode : VOICE_MODE;
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  const call = await client.calls.create({
    to,
    from: FROM_NUMBER,
    url: `${PUBLIC_URL}/voice`,
    statusCallback: `${PUBLIC_URL}/status`,
    statusCallbackMethod: 'POST',
  });
  activeCalls.set(call.sid, {
    goal,
    chatJid,
    history: [],
    currentLanguage: 'de-DE',
    voiceMode: mode as 'relay' | 'realtime',
  });
  logger.info({ callSid: call.sid, to, goal, mode }, 'Outbound call initiated');
}

export function startVoiceServer(deps: VoiceDeps): void {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER || !PUBLIC_URL) {
    logger.warn('Twilio not configured — voice server not started');
    return;
  }

  const openai = new OpenAI({ apiKey: env.HINDSIGHT_LLM_API_KEY });

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // Initial webhook: return TwiML based on VOICE_MODE
  app.post('/twilio/voice', (req, res) => {
    const callSid: string = req.body.CallSid;
    const state = activeCalls.get(callSid);
    const twiml = new VoiceResponse();

    if (!state) {
      twiml.say({ language: 'de-DE' }, 'Kein Kontext. Auf Wiederhören.');
      twiml.hangup();
    } else if (state.voiceMode === 'realtime') {
      // Media Streams mode → OpenAI Realtime API
      const wsUrl = PUBLIC_URL.replace(/^https?:\/\//, 'wss://') + '/media';
      const connect = twiml.connect();
      const stream = connect.stream({ url: wsUrl });
      stream.parameter({ name: 'callSid', value: callSid });
      logger.info(
        { callSid, wsUrl, twiml: twiml.toString() },
        'Realtime TwiML generated',
      );
    } else {
      // ConversationRelay mode (default)
      const wsUrl = PUBLIC_URL.replace(/^https?:\/\//, 'wss://') + '/ws';
      const voice =
        env.ELEVENLABS_VOICE_ID ||
        'lxYfHSkYm1EzQzGhdbfc-flash_v2_5-1.0_0.8_0.8';
      const connect = twiml.connect();
      connect.conversationRelay({
        url: wsUrl,
        welcomeGreeting:
          'Hallo, ich bin Andy und rufe im Auftrag von Operator an.',
        language: 'de-DE',
        ttsProvider: 'ElevenLabs',
        voice,
        elevenlabsTextNormalization: 'on',
        transcriptionProvider: 'google',
      } as Parameters<typeof connect.conversationRelay>[0]);
    }

    res.type('text/xml').send(twiml.toString());
  });

  // Status callback — handle failed/no-answer calls
  app.post('/twilio/status', (req, res) => {
    const callSid: string = req.body.CallSid;
    const status: string = req.body.CallStatus;
    const state = activeCalls.get(callSid);

    if (state && ['failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
      void deps.sendMessage(
        state.chatJid,
        `Anruf fehlgeschlagen (${status}). Ziel: ${state.goal}`,
      );
      activeCalls.delete(callSid);
    }

    res.sendStatus(200);
  });

  const server = http.createServer(app);

  // Manual WebSocket upgrade routing — two WSS on one server
  const wssRelay = new WebSocketServer({ noServer: true });
  const wssMedia = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url || '';
    if (pathname === '/twilio/ws') {
      wssRelay.handleUpgrade(request, socket, head, (ws) => {
        wssRelay.emit('connection', ws, request);
      });
    } else if (pathname === '/twilio/media') {
      wssMedia.handleUpgrade(request, socket, head, (ws) => {
        wssMedia.emit('connection', ws, request);
      });
    } else {
      logger.warn({ pathname }, 'Unknown WebSocket path, destroying');
      socket.destroy();
    }
  });

  // --- ConversationRelay WebSocket (relay mode) ---

  wssRelay.on('connection', (ws: WebSocket) => {
    let callSid: string | null = null;
    let state: CallState | null = null;

    ws.on('message', async (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'setup':
          callSid = msg.callSid as string;
          state = activeCalls.get(callSid) ?? null;
          logger.info({ callSid }, 'ConversationRelay session established');
          break;

        case 'prompt': {
          if (!state || !callSid) return;
          const userText = msg.voicePrompt as string;
          if (!userText?.trim()) return;

          logger.debug(
            { callSid, userText },
            'ConversationRelay prompt received',
          );
          state.history.push({ role: 'user', content: userText });

          const detectedLang = detectLanguage(userText);
          if (detectedLang !== state.currentLanguage) {
            state.currentLanguage = detectedLang;
            logger.info({ callSid, lang: detectedLang }, 'Language switch');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'language',
                  ttsLanguage: detectedLang,
                  transcriptionLanguage: detectedLang,
                }),
              );
            }
          }

          try {
            const stream = openai.chat.completions.stream({
              model: 'gpt-4o',
              max_tokens: 200,
              messages: [
                {
                  role: 'system',
                  content: `You are Andy, a personal assistant making a phone call on behalf of Operator (Munich, Germany).
Goal: ${state.goal}

Rules for spoken conversation (this is text-to-speech — follow strictly):
- Spell out numbers as words (e.g. "three pm" not "3pm", "forty-nine" not "49")
- No emojis, no bullet points, no markdown, no special characters
- Short sentences only — one idea at a time
- Respond in the same language the other person uses (default: German)
- When the goal is achieved or the call should end, finish your spoken goodbye naturally, then add the silent marker [END_CALL] at the very end. NEVER say the words "end call" aloud — the marker is invisible to the listener.`,
                },
                ...state.history,
              ],
            });

            let fullText = '';
            for await (const chunk of stream) {
              const token = chunk.choices[0]?.delta?.content ?? '';
              if (!token) continue;

              fullText += token;
              const isEndCall = fullText.includes('[END_CALL]');
              const spoken = token.replace('[END_CALL]', '');

              if (spoken && ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'text',
                    token: spoken,
                    last:
                      isEndCall || chunk.choices[0]?.finish_reason === 'stop',
                  }),
                );
              }

              if (isEndCall) break;
            }

            state.history.push({ role: 'assistant', content: fullText });

            if (fullText.includes('[END_CALL]')) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'endSession' }));
              }
              activeCalls.delete(callSid);
              void deps.sendMessage(state.chatJid, buildSummary(state));
            }
          } catch (err) {
            logger.error(
              { err, callSid },
              'Error generating response during call',
            );
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'text',
                  token:
                    'Entschuldigung, ein Fehler ist aufgetreten. Auf Wiederhören.',
                  last: true,
                }),
              );
              ws.send(JSON.stringify({ type: 'endSession' }));
            }
            if (callSid) activeCalls.delete(callSid);
          }
          break;
        }

        case 'interrupt':
          logger.debug({ callSid }, 'User interrupted TTS');
          break;

        case 'error':
          logger.error(
            { callSid, description: msg.description },
            'ConversationRelay error',
          );
          break;
      }
    });

    ws.on('close', () => {
      if (callSid && state) {
        logger.info({ callSid }, 'ConversationRelay session closed');
        activeCalls.delete(callSid);
      }
    });
  });

  // --- Media Streams WebSocket (realtime mode) ---
  wssMedia.on('connection', (twilioWs: WebSocket) => {
    logger.info('Twilio Media Stream WebSocket connection received');
    let callSid: string | null = null;
    let state: CallState | null = null;
    let streamSid: string | null = null;
    let openaiWs: WebSocket | null = null;
    const transcript: Array<{ role: 'user' | 'assistant'; text: string }> = [];

    twilioWs.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Log all non-media events (media events are too frequent)
      if (msg.event !== 'media' && msg.type !== 'media') {
        logger.info(
          { event: msg.event || msg.type, streamSid: msg.streamSid },
          'Twilio Media Stream event received',
        );
      }

      // Twilio Media Streams uses 'event' not 'type'
      const eventType = (msg.event || msg.type) as string;

      switch (eventType) {
        case 'connected':
          logger.info('Twilio Media Stream connected');
          break;

        case 'start': {
          const startMsg = msg.start as Record<string, unknown>;
          streamSid = msg.streamSid as string;
          logger.info(
            { streamSid, startMsg: JSON.stringify(startMsg) },
            'Realtime: raw start event',
          );
          callSid =
            (startMsg?.callSid as string) ||
            ((startMsg?.customParameters as Record<string, string>)
              ?.callSid as string);
          state = callSid ? (activeCalls.get(callSid) ?? null) : null;

          if (!state || !callSid) {
            logger.warn(
              { callSid, activeCalls: [...activeCalls.keys()] },
              'Realtime: no call state found',
            );
            twilioWs.close();
            return;
          }

          logger.info({ callSid, streamSid }, 'Realtime session starting');

          // Connect to OpenAI Realtime API
          openaiWs = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
            {
              headers: {
                Authorization: `Bearer ${env.HINDSIGHT_LLM_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1',
              },
            },
          );

          openaiWs.on('open', () => {
            logger.info({ callSid }, 'OpenAI Realtime WebSocket connected');

            // Configure the session
            openaiWs!.send(
              JSON.stringify({
                type: 'session.update',
                session: {
                  instructions: `You are Andy, a personal assistant making a phone call on behalf of Operator (Munich, Germany).
Goal: ${state!.goal}

Rules:
- Respond in the same language the other person uses (default: German)
- Keep responses short — one or two sentences at a time
- Be natural, warm, and conversational
- Start by greeting the person and explaining why you are calling
- When the goal is achieved, say a natural goodbye and stop responding`,
                  voice: REALTIME_VOICE,
                  input_audio_format: 'g711_ulaw',
                  output_audio_format: 'g711_ulaw',
                  input_audio_transcription: { model: 'whisper-1' },
                  turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                  },
                },
              }),
            );

            // Trigger initial greeting — the model speaks first
            openaiWs!.send(
              JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['audio', 'text'],
                  instructions:
                    'Greet the person warmly in German. Introduce yourself as Andy calling on behalf of Operator, then briefly state the purpose of the call.',
                },
              }),
            );
          });

          openaiWs.on('message', (data: Buffer) => {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data.toString());
            } catch {
              return;
            }

            switch (event.type) {
              case 'response.audio.delta':
                // Forward audio from OpenAI to Twilio
                if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
                  twilioWs.send(
                    JSON.stringify({
                      event: 'media',
                      streamSid,
                      media: { payload: event.delta as string },
                    }),
                  );
                }
                break;

              case 'input_audio_buffer.speech_started':
                // User started talking — clear any pending Twilio audio
                if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
                  twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
                }
                break;

              case 'conversation.item.input_audio_transcription.completed':
                if (event.transcript) {
                  const text = (event.transcript as string).trim();
                  if (text) {
                    transcript.push({ role: 'user', text });
                    logger.debug({ callSid, text }, 'Realtime user transcript');
                  }
                }
                break;

              case 'response.audio_transcript.done':
                if (event.transcript) {
                  const text = (event.transcript as string).trim();
                  if (text) {
                    transcript.push({ role: 'assistant', text });
                    logger.debug(
                      { callSid, text },
                      'Realtime assistant transcript',
                    );
                  }
                }
                break;

              case 'error':
                logger.error(
                  { callSid, error: event.error },
                  'OpenAI Realtime error',
                );
                break;
            }
          });

          openaiWs.on('error', (err) => {
            logger.error({ callSid, err }, 'OpenAI Realtime WebSocket error');
          });

          openaiWs.on('close', () => {
            logger.info({ callSid }, 'OpenAI Realtime WebSocket closed');
          });

          break;
        }

        case 'media': {
          // Forward audio from Twilio to OpenAI
          const media = msg.media as Record<string, unknown>;
          if (openaiWs?.readyState === WebSocket.OPEN && media?.payload) {
            openaiWs.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: media.payload as string,
              }),
            );
          }
          break;
        }

        case 'stop':
          logger.info({ callSid, streamSid }, 'Twilio Media Stream stopped');
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          // Send summary
          if (state && callSid) {
            const summary = buildRealtimeSummary(state.goal, transcript);
            void deps.sendMessage(state.chatJid, summary);
            activeCalls.delete(callSid);
          }
          break;
      }
    });

    twilioWs.on('close', () => {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
      if (callSid && state) {
        const summary = buildRealtimeSummary(state.goal, transcript);
        void deps.sendMessage(state.chatJid, summary);
        activeCalls.delete(callSid);
      }
      logger.info({ callSid }, 'Twilio Media Stream WebSocket closed');
    });

    twilioWs.on('error', (err) => {
      logger.error({ callSid, err }, 'Twilio Media Stream WebSocket error');
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT, mode: VOICE_MODE }, 'Voice server started');
  });
}

function buildSummary(state: CallState): string {
  const turns = state.history
    .map(
      (m) =>
        `${m.role === 'user' ? 'Andere Seite' : 'Andy'}: ${m.content.replace('[END_CALL]', '').trim()}`,
    )
    .join('\n');
  return `Anruf abgeschlossen.\nZiel: ${state.goal}\n\n${turns}`;
}

function buildRealtimeSummary(
  goal: string,
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>,
): string {
  const turns = transcript
    .map((t) => `${t.role === 'user' ? 'Andere Seite' : 'Andy'}: ${t.text}`)
    .join('\n');
  return `Anruf abgeschlossen.\nZiel: ${goal}\n\n${turns || '(Kein Transkript verfügbar)'}`;
}
