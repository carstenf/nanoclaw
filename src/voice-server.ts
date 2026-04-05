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
]);

const PORT = parseInt(env.VOICE_SERVER_PORT || '3600', 10);
const PUBLIC_URL = env.VOICE_PUBLIC_URL; // e.g. https://domain.ngrok.dev/twilio
const ACCOUNT_SID = env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = env.TWILIO_FROM_NUMBER;

const VoiceResponse = twilio.twiml.VoiceResponse;

interface CallState {
  goal: string;
  chatJid: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentLanguage: string;
}

// Detect spoken language from transcribed text — used to switch TTS/STT mid-call
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
  return best[1] > 0 ? best[0] : 'de-DE'; // default German
}

const activeCalls = new Map<string, CallState>();

export interface VoiceDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export async function makeCall(
  to: string,
  goal: string,
  chatJid: string,
): Promise<void> {
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
  });
  logger.info({ callSid: call.sid, to, goal }, 'Outbound call initiated');
}

export function startVoiceServer(deps: VoiceDeps): void {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER || !PUBLIC_URL) {
    logger.warn('Twilio not configured — voice server not started');
    return;
  }

  const openai = new OpenAI({ apiKey: env.HINDSIGHT_LLM_API_KEY });

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // Initial webhook: return ConversationRelay TwiML
  app.post('/twilio/voice', (req, res) => {
    const callSid: string = req.body.CallSid;
    const state = activeCalls.get(callSid);
    const twiml = new VoiceResponse();

    if (!state) {
      twiml.say({ language: 'de-DE' }, 'Kein Kontext. Auf Wiederhören.');
      twiml.hangup();
    } else {
      const wsUrl = PUBLIC_URL.replace(/^https?:\/\//, 'wss://') + '/ws';
      // ElevenLabs Sarah (multilingual), Flash 2.5 model for lowest latency
      const voice =
        env.ELEVENLABS_VOICE_ID ||
        'EXAVITQu4vr4xnSDxMaL-flash_v2_5-1.0_0.8_0.8';
      const connect = twiml.connect();
      connect.conversationRelay({
        url: wsUrl,
        welcomeGreeting:
          'Hallo, ich bin Andy und rufe im Auftrag von Carsten an.',
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

  // WebSocket server for ConversationRelay turns
  const wss = new WebSocketServer({ server, path: '/twilio/ws' });

  wss.on('connection', (ws: WebSocket) => {
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

          // Detect language from caller's speech and switch TTS/STT if changed
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
                  content: `You are Andy, a personal assistant making a phone call on behalf of Carsten (Munich, Germany).
Goal: ${state.goal}

Rules for spoken conversation (this is text-to-speech — follow strictly):
- Spell out numbers as words (e.g. "three pm" not "3pm", "forty-nine" not "49")
- No emojis, no bullet points, no markdown, no special characters
- Short sentences only — one idea at a time
- Respond in the same language the other person uses (default: German)
- When the goal is achieved or the call should end, append [END_CALL] to your final response`,
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

  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Voice server started (ConversationRelay)');
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
