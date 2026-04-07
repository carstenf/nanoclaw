# Outbound Audio Problem — Analyse und Änderungsplan

**Stand: 2026-04-07 20:50 UTC**

## Problem

Outbound-Calls (Andy ruft jemanden an): Angerufener hört NICHTS.
Inbound-Calls (jemand ruft Andy an): Audio fließt bidirektional ✅.

## Was bewiesen ist

### 1. Signaling funktioniert ✅
- SIP INVITE → Sipgate → Callee antwortet → 200 OK → ACK mit rtpengine-SDP
- OpenAI Webhook kommt an, Call wird accepted
- WebSocket-Events zeigen: OpenAI generiert Audio (`output_audio_buffer.started`)

### 2. Caller → OpenAI funktioniert ✅ (seit CT-Zonen-Fix)
- `input_audio_buffer.speech_started` Events in den Logs
- Sipgate leitet Caller-RTP an unseren rtpengine weiter
- rtpengine verschlüsselt und sendet an OpenAI
- OpenAI empfängt und transkribiert

### 3. OpenAI → rtpengine funktioniert ✅
- rtpengine Final Stats: 2998 Pakete empfangen auf OpenAI-Leg, 0 Errors
- SRTP-Entschlüsselung mit AES_CM_128_HMAC_SHA1_80 funktioniert
- Debug-Log zeigt: `Forward to sink endpoint: 217.10.77.156:26240 (RTP seq 2998)`

### 4. rtpengine → Hetzner → Internet funktioniert ✅
- tcpdump auf wg0 (Hetzner): Pakete kommen an (`10.0.0.2:40052 → 212.9.44.165:15392`)
- tcpdump auf eth0 (Hetzner): Pakete verlassen Server (`128.140.104.236:40052 → 212.9.44.165:15392`)
- SNAT funktioniert: Source-IP korrekt, Source-Port bleibt erhalten

### 5. Sipgate empfängt unsere Pakete (wahrscheinlich)
- Pakete verlassen Hetzner korrekt an Sipgate-Media-Server
- Sipgate-History zeigt PICKUP mit Dauer (10-16s)
- Kein Fehler-Response von Sipgate

## Was NICHT funktioniert

**Sipgate relayed unsere RTP-Pakete nicht an das Telefon des Angerufenen.**

## Hypothesen (nach Ausschluss)

### ❌ Ausgeschlossen
- **Conntrack-Kollision**: Gefixt mit CT-Zonen. Pakete fließen bidirektional.
- **rtpengine Crypto-Bug**: Debug-Logs zeigen korrekte Entschlüsselung, 0 Errors.
- **Firewall/Routing**: tcpdump beweist Pakete verlassen Hetzner korrekt.
- **sipgate.io outgoingUrl**: Entfernt, Problem bleibt.
- **RTP-Latching**: playMedia auf beide Legs, Sipgate sendet zurück.

### 🔶 Verbleibende Hypothese: Sipgate erwartet SRTP, nicht plain RTP

**Kernunterschied Inbound vs. Outbound:**

| | Inbound (funktioniert) | Outbound (kaputt) |
|---|---|---|
| Sipgate SDP | RTP/SAVP (SRTP) | RTP/AVP (plain) |
| Unser Answer an Sipgate | RTP/SAVP (SRTP) | RTP/AVP (plain) |
| rtpengine Bridging | SRTP ↔ SRTP | plain ↔ SRTP |

Sipgate registriert unser Device e5 via TLS (Port 5061). Sipgate könnte intern
für alle Calls über dieses Device SRTP erwarten, auch wenn das callee-SDP
plain RTP anbietet. Sipgate bietet plain RTP im SDP an, weil das der Default
für den Callee-Leg ist — aber für den Device-Leg (uns) erwartet Sipgate SRTP.

**Beweis wäre:** Outbound-Answer auf RTP/SAVP umstellen → Audio fließt.

### 🔶 Alternative Hypothese: Sipgate ignoriert ACK-SDP bei Late Offer

Unser Outbound-Call nutzt "late offer" (INVITE ohne SDP, SDP erst im ACK).
Manche SIP-Implementierungen verarbeiten das ACK-SDP nicht korrekt und
nutzen stattdessen intern einen Default-Media-Pfad, der nicht zu unserer
rtpengine-Adresse passt.

**Beweis wäre:** Auf "early offer" umstellen (SDP im INVITE) → Audio fließt.

## Geplante Änderungen (in Reihenfolge)

### Änderung A: Outbound-Answer auf RTP/SAVP + SDES

**Datei:** `src/sipgate-voice.ts`, Funktion `buildOpenAILeg`

**Aktuell (Zeile ~481-492):**
```javascript
const answerRes = await rtpEngine.answer({
  ...
  'transport-protocol': 'RTP/AVP',  // plain RTP
});
```

**Neu:**
```javascript
const answerRes = await rtpEngine.answer({
  ...
  SDES: 'on',                       // generate SDES crypto for Sipgate
  'transport-protocol': 'RTP/SAVP', // SRTP — matching inbound behavior
});
```

**Zusätzlich:** `cleanSdpAnswer()` darf die crypto-Zeilen NICHT strippen.
Aktuell strippt sie nur DTLS-Attribute (`a=tls-id`, `a=setup`, `a=fingerprint`),
crypto-Zeilen (`a=crypto:`) bleiben erhalten. Keine Änderung nötig.

**Risiko:** Niedrig. Wenn Sipgate plain RTP erwartet und SRTP ablehnt,
sehen wir das sofort (kein Audio oder SIP-Fehler). Inbound bleibt unverändert.

### Änderung B (falls A nicht hilft): Early Offer statt Late Offer

**Datei:** `src/sipgate-voice.ts`, Funktion `makeSipgateCall`

**Aktuell:** `createUAC(sipUri, { noAck: true })` → kein SDP im INVITE
**Neu:** Erst rtpengine offer aufrufen, dann `createUAC(sipUri, { localSdp: ... })`

Das ist eine größere Änderung, da der gesamte Outbound-Flow umgebaut werden muss.

### Änderung C (falls B nicht hilft): connectionIds untersuchen

Sipgate-History zeigt `connectionIds: ["p0", "p2"]`. Device e5 ist auf beiden
Phonelines aktiv. Möglicherweise routet Sipgate den Outbound-Call über p0
(Default-Phoneline) statt p2 (NanoClaw), und p0 hat andere Media-Einstellungen.

**Test:** Device e5 nur auf p2 aktiv lassen, p0 entfernen.

## Testergebnis Änderung A (2026-04-07 20:52 UTC)

**Ergebnis: Audio fließt immer noch nicht.** Aber wichtige Erkenntnis:

rtpengine setzt `RTP/SAVP` im Answer-SDP, generiert aber **keine `a=crypto:` Zeile**.
SAVP ohne SDES-Keys ist nutzlos — Sipgate kann das nicht entschlüsseln.

**Root Cause von Änderung A's Scheitern:** rtpengine's `SDES: 'on'` im Answer
generiert keine neuen SDES-Keys für die from-tag-Seite (Sipgate), weil diese
Seite im Offer bereits als plain RTP/AVP etabliert wurde. rtpengine ändert nur
das transport-protocol Label, fügt aber keine Crypto-Suite hinzu.

**Lösung:** SDES-Keys müssen bereits im Offer für BEIDE Seiten generiert werden.
Das bedeutet: der Offer muss die callee-SDP als SAVP behandeln (nicht als AVP),
damit rtpengine von Anfang an SDES für die Sipgate-Seite einrichtet.

## Nächster Schritt (morgen)

### Änderung A2: SDES auch im Offer für die Sipgate-Seite

Im Offer die callee-SDP manipulieren: `RTP/AVP` → `RTP/SAVP` ersetzen,
damit rtpengine SDES-Keys für die Sipgate-Seite generiert. Dann sollte
der Answer-Output auch Crypto-Zeilen enthalten.

Alternativ: rtpengine Offer-Flags `generate-SDES` oder `force-SDES`
prüfen (Doku: https://github.com/sipwise/rtpengine#the-ng-control-protocol).

### Falls das nicht hilft: Änderung B (Early Offer) oder C (connectionIds)

Siehe oben.

## Positive Zwischenergebnisse

1. **CT-Zonen-Fix auf Hetzner ist live und funktioniert** — bidirektionaler
   RTP-Traffic fließt, Caller-Audio erreicht OpenAI.
2. **rtpengine Debug-Level ist auf 7** — zurücksetzen auf 6 nach Abschluss.
3. **sipgate.io outgoingUrl entfernt** — kein Webhook-Eingriff mehr bei Outbound.
