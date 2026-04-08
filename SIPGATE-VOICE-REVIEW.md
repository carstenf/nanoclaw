# Sipgate Voice — Umsetzung & Review (2026-04-08)

## Ausgangslage

Outbound-Calls (Andy ruft jemanden an) hatten **kein Audio** — der Angerufene hörte nichts. Inbound-Calls (jemand ruft Andy an) funktionierten.

**Root Cause:** Device e5 war per TLS:5061 bei Sipgate registriert. Sipgate erzwingt SRTP bei TLS-Signaling. rtpengine konnte die asymmetrische SRTP-RTP-Bridging im Late-Offer-Szenario nicht korrekt durchführen (bekanntes Issue: sipwise/rtpengine#1424).

---

## Was umgesetzt wurde

### 1. UDP-Registrierung statt TLS

**Vorher:** `sip:sip.sipgate.de;transport=tls` (Port 5061)
**Nachher:** `sip:sipgate.de;transport=udp` (Port 5060)

- Sipgate erzwingt SRTP **nur** bei TLS. Mit UDP akzeptiert Sipgate plain RTP.
- Wichtig: `sipgate.de` statt `sip.sipgate.de` — nur `sipgate.de` antwortet auf UDP.
- `;transport=udp` muss explizit im URI stehen, sonst wählt drachtio via DNS SRV automatisch TLS.

### 2. Early Offer statt Late Offer (Outbound)

**Vorher:** Late Offer — INVITE ohne SDP, SDP erst im ACK.
**Nachher:** Early Offer — SDP bereits im INVITE.

Late Offer funktioniert nicht mit Sipgate/UDP (200 OK enthält kein SDP). Der Flow ist jetzt:

```
1. Synthetisches plain RTP SDP → rtpengine → SRTP SDP für OpenAI
2. INVITE OpenAI mit SRTP SDP → OpenAI antwortet
3. rtpengine answer → plain RTP SDP für Sipgate
4. INVITE Sipgate MIT SDP (Early Offer, UDP)
5. Sipgate antwortet → re-offer mit echtem SDP
6. playMedia Latching (200ms) → Audio fließt
7. 1s Pause → Andy beginnt zu sprechen
```

### 3. Re-Offer nach Sipgate-Antwort

Der re-offer aktualisiert rtpengine mit Sipgate's echtem Media-Endpoint (IP:Port). Ohne re-offer weiß rtpengine nicht, wohin die RTP-Pakete geschickt werden sollen.

**Wichtig:** Re-offer mit plain RTP ist safe. Der vorherige Versuch mit SRTP re-offer hatte den OpenAI-Leg zerstört (0 Pakete nach re-offer). Mit plain RTP tritt dieses Problem nicht auf.

### 4. Greeting-Timing (Anti-Stottern)

**Problem:** Andy's Greeting wurde ausgelöst, sobald der OpenAI-WebSocket sich öffnete — noch bevor Sipgate abnahm. OpenAI pufferte ~8 Sekunden Audio, das dann beim Pickup auf einmal rausgeflutet wurde.

**Lösung:** Greeting wird erst 1 Sekunde NACH Sipgate's Antwort ausgelöst. So ist der Media-Pfad bereit, bevor das erste echte Audio fließt.

### 5. Inbound-Pfad angepasst (dynamische Protokoll-Erkennung)

Mit UDP-Registrierung sendet Sipgate Inbound-INVITEs ebenfalls via UDP mit plain RTP. Der Inbound-Handler erkennt jetzt automatisch ob Sipgate SRTP oder plain RTP sendet und passt die rtpengine-Antwort entsprechend an.

### 6. Latching-Tuning

| Richtung | playMedia | Dauer | Delay | Greeting |
|----------|-----------|-------|-------|----------|
| Inbound  | Beide Legs | 2x 500ms | 500ms für OpenAI-Leg | 2s nach WS-Open |
| Outbound | Beide Legs | 1x 200ms | 500ms für OpenAI-Leg | 1s nach Sipgate-Pickup |

Inbound braucht längeres Latching weil kein re-offer die Endpoints vorher konfiguriert. Outbound braucht nur einen kurzen Impuls weil der re-offer die Endpoints bereits kennt.

---

## Aktueller Stand (2026-04-08 abends)

| Richtung | Status | Audio | Qualität |
|----------|--------|-------|----------|
| Inbound  | Funktioniert | Bidirektional | Gut, leicht blechern (G.711 8kHz) |
| Outbound | Funktioniert | Bidirektional | Gut, leicht blechern (G.711 8kHz) |

### Architektur
```
Sipgate ←UDP/RTP→ Hetzner(rtpengine) ←SRTP→ OpenAI
                      ↕ ng-protocol via WireGuard
              Lenovo1(drachtio + NanoClaw)
```

### Verbleibende Qualitätsprobleme
1. **Blecherner Klang**: G.711 a-law = 8kHz/64kbps Telefonqualität. Lösung: G.722 (16kHz) oder Opus (48kHz)
2. **Leichtes Rauschen**: Möglicherweise Comfort Noise oder silence.wav Artefakte
3. **SIP-Signaling über WireGuard**: drachtio auf Lenovo1, da Stock-Image kein TLS hat

### Nächster Schritt: FreeSWITCH
FreeSWITCH als zusätzlicher Call-Modus (`voice_mode: 'freeswitch'`) löst alle drei Probleme:
- Native Codec-Unterstützung (G.722, Opus, Transcoding)
- Native SRTP per-Leg (`rtp_secure_media`)
- Native TLS, läuft direkt auf Hetzner
- `mod_audio_fork` für direktes WebSocket-Streaming an OpenAI
- 1 Prozess statt 2 (drachtio + rtpengine entfallen für diesen Modus)

---

## Bekannte Einschränkungen & Verbesserungspotenzial

### Audioqualität

1. **rtpengine Userspace-Processing ("no kernel support")**
   - rtpengine verarbeitet jedes RTP-Paket im Userspace statt im Kernel
   - Fügt ~1-5ms Jitter pro Paket hinzu (bei 50 Paketen/Sekunde spürbar)
   - **Fix:** rtpengine Kernel-Modul installieren (erfordert Kernel-Headers im Docker-Container oder Host-Installation)

2. **Minimales Stottern am Outbound-Start**
   - Die ersten 1-2 Worte können leicht abgehackt sein (playMedia-Kollision)
   - Könnte durch längeren Greeting-Delay (2s statt 1s) weiter verbessert werden
   - Oder: playMedia komplett ersetzen durch rtpengine `start-recording` Trigger

3. **Doppelter WireGuard-Hop**
   - Jedes RTP-Paket: Sipgate → Hetzner (DNAT) → WireGuard → Lenovo1 (rtpengine) → WireGuard → Hetzner (SNAT) → OpenAI
   - Fügt ~2-4ms Latenz pro Richtung hinzu
   - **Fix:** rtpengine auf Hetzner statt Lenovo1 laufen lassen (eliminiert WireGuard-Hop)

### Leitungsqualität / Architektur

4. **OpenAI EU Data Residency**
   - Aktuell: OpenAI US East (~90ms RTT von Deutschland)
   - Möglich: `eu.api.openai.com` oder Azure OpenAI Sweden Central (~25ms RTT)
   - **Einsparung: ~130ms Round-Trip** — bei AI-Inferenz-Latenz von 300-800ms ein merklicher Gewinn

5. **FreeSWITCH statt drachtio+rtpengine**
   - FreeSWITCH löst SRTP-Bridging nativ mit per-Leg `rtp_secure_media`
   - Eliminiert das gesamte SRTP-Problem, kein re-offer nötig
   - `mod_audio_fork` für direktes WebSocket-Streaming zu OpenAI
   - **2 statt 3 Elemente** in der Media-Strecke
   - Aufwand: 1-2 Tage Umbau

6. **Codec-Optimierung**
   - Aktuell: G.711 a-law (PCMA/8000) — 64kbps, 8kHz
   - Option: G.722 (HD Voice, 16kHz) falls Sipgate und OpenAI es unterstützen
   - Bessere Sprachqualität, gleiche Bandbreite

7. **Easybell als Alternative zu Sipgate**
   - SIP-Trunking ab 1,95 EUR/Monat, SRTP optional (kein Zwang)
   - Würde das gesamte UDP/TLS-Problem eliminieren
   - Nummernportierung von Sipgate möglich

### Priorisierte Empfehlung (aktualisiert 2026-04-08 abends)

| Priorität | Maßnahme | Aufwand | Effekt | Status |
|-----------|----------|---------|--------|--------|
| ~~1~~ | ~~OpenAI EU Endpoint~~ | — | — | Nicht verfügbar für SIP (nur Azure) |
| ~~2~~ | ~~rtpengine Kernel-Modul~~ | — | — | Versions-Mismatch, Modul fing Pakete ab. Geparkt. |
| ~~3~~ | ~~rtpengine auf Hetzner~~ | — | — | ✅ Erledigt |
| 1 | **FreeSWITCH als neuer Call-Modus** | 1-2 Tage | Beste Lösung: Codec/SRTP/Architektur | In Planung |
| 2 | drachtio TLS auf Hetzner fixen | 2-4h | Letzten WG-Hop für SIP eliminieren | Offen (autoconf-Bug) |
| 3 | Easybell-Wechsel | 1 Tag | Kein TLS/SRTP-Zwang | Offen |

---

## Dateien

| Datei | Änderungen |
|-------|-----------|
| `src/sipgate-voice.ts` | UDP-Registrierung, Early Offer, re-offer, Latching, Greeting-Timing |
| `OUTBOUND-AUDIO-ANALYSIS.md` | Vollständige Diagnose-Historie und finale Lösung |
| `/opt/server-docs/hetzner-mcp-architecture.md` | Bekannte Probleme aktualisiert |

## Infrastruktur (unverändert)

- drachtio: Lenovo1 Docker, Ports 5060/5061/9022
- rtpengine: Lenovo1 Docker, `--interface=10.0.0.2!128.140.104.236`, **log-level=6**
- Hetzner DNAT: UDP/TCP 5060, TCP 5061, UDP 40000-40100 → 10.0.0.2
- Hetzner CT-Zonen: raw PREROUTING zone 1 (eth0), zone 2 (wg0)
