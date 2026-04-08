# Phone Call Skill — NanoClaw Voice via FreeSWITCH

## Architektur

```
Sipgate ←UDP/G.722→ FreeSWITCH(Hetzner) ←TLS/SRTP/PCMA→ OpenAI Realtime API
                          ↕ ESL (outbound only)
                     NanoClaw(Lenovo1) ← Webhook (inbound)
```

- **FreeSWITCH** auf Hetzner (Docker, `--network=host`)
- **Sipgate** Device e5, Nummer +49308687022345
- **OpenAI** Realtime API via SIP (`sip:PROJECT_ID@sip.api.openai.com;transport=tls`)
- **NanoClaw** steuert Outbound via ESL, empfängt Inbound via OpenAI Webhook

## Call-Modi

| Mode | Route | Codec | Status |
|------|-------|-------|--------|
| **freeswitch** (default) | FreeSWITCH → OpenAI SIP | G.722 16kHz (HD Voice) | Produktiv |
| sipgate (archiviert) | drachtio+rtpengine → OpenAI SIP | G.711 8kHz | Backup (Commit c926004) |
| realtime | Twilio → OpenAI Realtime | G.711 | Fallback |
| relay | Twilio → ElevenLabs | ElevenLabs | Announcements |

## Voice-Auswahl

Per Call konfigurierbar via `voice` Parameter im IPC:

| Voice | Charakter | Default |
|-------|-----------|---------|
| **shimmer** | Warm, klar, wenig Rauschen | ✅ Default |
| **alloy** | Neutral, sehr sauberer Klang | |
| **coral** | Lebendig, expressiv | |
| **echo** | Männlich, tief, ruhig | |
| **onyx** | Männlich, autoritär | |
| **fable** | Britisch, warm | |
| **nova** | Energisch, jung | |

## Outbound Call Flow

```
1. IPC: make_call { to, goal, voice_mode: "freeswitch", voice: "shimmer" }
2. ESL: originate sofia/gateway/sipgate/+49... &park()
3. Sipgate → Callee: klingelt
4. Callee nimmt ab → FreeSWITCH parkt Channel
5. ESL: uuid_transfer → openai Extension (bridge zu OpenAI SIP)
6. OpenAI → Webhook → NanoClaw: accept + WebSocket
7. Greeting State Machine startet (siehe unten)
```

## Inbound Call Flow

```
1. Anrufer → Sipgate → FreeSWITCH (Dialplan: ring_ready + 6s + answer)
2. FreeSWITCH bridge direkt zu OpenAI SIP
3. OpenAI → Webhook → NanoClaw: accept + WebSocket
4. Greeting State Machine startet (Inbound-Variante)
```

## Greeting State Machine (Outbound)

### Bedingung A — Callee spricht ("Hallo"):
- OpenAI VAD erkennt Sprache automatisch
- Andy antwortet mit Goal-Text
- Timer werden gecancelt

### Bedingung B — Callee schweigt:
| Zeit | Aktion |
|------|--------|
| 0s | Warte auf Sprache |
| 5s | "Hallo? Ist da jemand?" |
| 8s | "Hallo?" |
| 11s | "Hallo?" |
| 13s | Auto-Hangup |

### Technische Umsetzung:
- `session.update` mit `turn_detection: null` (VAD aus)
- `conversation.item.create` mit konkretem Text (schneller als `response.create` mit instructions)
- `response.create` ohne instructions (triggert Antwort auf den conversation item)
- `response.done` → VAD wieder aktivieren
- `speech_started` → alle Timer canceln

## Greeting State Machine (Inbound)

- Sofort nach WS-Open: VAD deaktivieren → `conversation.item.create` ("Hallo, hier ist Andy") → `response.create`
- Nach `response.done`: VAD aktivieren, Silence-Timer starten

## Mid-Call Silence Detection (beide Richtungen)

| Zeit nach letzter Sprache | Aktion |
|---------------------------|--------|
| 6s | VAD aus → "Hallo? Bist du noch da?" |
| 9s | "Hallo?" |
| 12s | Auto-Hangup |

- Timer startet nach `speech_stopped` (User hört auf zu sprechen)
- Timer wird gecancelt bei `speech_started`
- Funktioniert als Goodbye-Ersatz (nach "Tschüss" kommt natürlich Stille)

## Wichtige technische Details

### conversation.item.create vs response.create
- `response.create` mit `instructions`: 5-14s Delay in SIP-Modus (VAD blockiert)
- `conversation.item.create` + `response.create` (ohne instructions): <1s Delay
- Immer `conversation.item.create` verwenden für schnelle Antworten

### VAD Management
- VAD muss für `conversation.item.create` + `response.create` deaktiviert sein
- Nach `response.done` VAD wieder aktivieren
- `session.update` mit `turn_detection: null` zum Deaktivieren

### Transcript
- OpenAI SIP-Modus liefert KEINE zuverlässigen Transcript-Events auf dem Control-WebSocket
- `input_audio_transcription` und `response.audio_transcript.done` kommen nicht oder unvollständig
- Goodbye-Detection via Transcript funktioniert daher nicht → Silence Detection als Fallback
- TODO: Function Calling für zuverlässige Goodbye-Detection

### FreeSWITCH Konfiguration
- SIP Port: 5060 (UDP)
- TLS Port: 5061 (für OpenAI)
- RTP Ports: 60000-60100
- ESL Port: 8021
- Sipgate Gateway: `sipgate.de`, `transport=udp`
- Codecs: G.722 (Sipgate), PCMA (OpenAI), Transcoding by FreeSWITCH
- Comfort Noise: deaktiviert (`suppress_cng`, `bridge_generate_comfort_noise=false`)

### Ports (Hetzner Firewall)
| Port | Proto | Zweck |
|------|-------|-------|
| 5060 | UDP/TCP | SIP Signaling |
| 5061 | TCP | SIP TLS (OpenAI) |
| 60000-61000 | UDP | RTP Media |

### Docker Container
```bash
docker run -d --name nanoclaw-freeswitch \
  --network=host --restart=unless-stopped \
  -v /etc/ssl/certs:/etc/ssl/certs:ro \
  -v /home/carsten/voip-config/agent.pem:/etc/freeswitch/tls/agent.pem:ro \
  -v /home/carsten/voip-config/cafile.pem:/etc/freeswitch/tls/cafile.pem:ro \
  -e SIPGATE_SIP_USER=8702234e5 \
  -e SIPGATE_SIP_PASSWORD=*** \
  -e OPENAI_PROJECT_ID=proj_*** \
  nanoclaw-freeswitch:latest
```

## Dateien

| Datei | Zweck |
|-------|-------|
| `src/freeswitch-voice.ts` | ESL-Client, Call-Management, Greeting State Machine |
| `src/openai-webhook.ts` | Webhook-Server für OpenAI SIP Callbacks |
| `freeswitch-config/` | Dockerfile, Entrypoint, Dialplan, Gateway, Vars |
| `groups/main/CLAUDE.md` | Voice-Modi und Stimmen-Doku für Andy |

## Backup

Alter drachtio+rtpengine Stack: Git Commit `c926004`
```bash
git checkout c926004 -- src/sipgate-voice.ts  # Restore old file
```
