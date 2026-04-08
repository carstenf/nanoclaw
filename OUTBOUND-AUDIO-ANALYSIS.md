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

## Testergebnisse Session 2 (2026-04-07 21:30–22:20 UTC)

### Versuch: OSRTP=offer (Aufgabe 1 aus BRIEFING.md)
- `OSRTP: 'offer'` + `transport-protocol: 'RTP/AVP'` im Offer
- **Ergebnis:** rtpengine Offer-Response enthält kein Crypto. OSRTP hat keine Wirkung.
- **Ursache:** Unser rtpengine-Image (drachtio/rtpengine:latest) ignoriert OSRTP=offer
  (vgl. rtpengine Issue #976: OSRTP generiert in bestimmten Versionen keine Crypto).

### Versuch: OSRTP + RTP/SAVP im Offer
- `OSRTP: 'offer'` + `transport-protocol: 'RTP/SAVP'` im Offer
- **Ergebnis:** OpenAI-SDP hat Crypto ✅, aber Sipgate-Answer-SDP hat SAVP ohne Crypto.
- **Ursache:** OSRTP hat keinen Effekt auf die from-tag-Seite im Answer.

### Versuch: SDP-Manipulation (callee SDP RTP/AVP → RTP/SAVP)
- callee-SDP manuell auf RTP/SAVP umgeschrieben vor rtpengine.offer()
- **Ergebnis:** Answer hat RTP/SAVP aber immer noch keine `a=crypto:` Zeile.
- **Ursache:** rtpengine braucht `a=crypto:` Zeilen in der Eingabe-SDP um Crypto zu generieren.

### Versuch: SDP-Manipulation + injizierte Crypto-Zeile
- callee-SDP → RTP/SAVP + generierte `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:<key>`
- **Ergebnis:** Answer hat `RTP/SAVP` + `a=crypto:` ✅ — vollständige SRTP-Negotiation!
- **ABER kein Audio:** Sipgate empfängt unsere SRTP-Pakete, sendet aber NICHTS zurück.
  Final Stats: Sipgate-Leg 0 Pakete empfangen.
- **Root Cause:** Late Offer + SRTP funktioniert nicht. Sipgate setzt Media-Pipeline in
  der 200 OK auf plain RTP. Unser ACK-SAVP+Crypto kommt zu spät — Sipgate kann nicht
  mehr auf SRTP umschalten, weil die 200 OK bereits committed ist.

### Versuch: Early Offer (Änderung B)
- Kompletter Umbau: OpenAI zuerst anrufen, dann Sipgate mit SRTP-SDP im INVITE
- **Ergebnis:** Sipgate antwortet mit `RTP/SAVP` + eigener Crypto ✅✅
- rtpengine re-offer mit Sipgate's echtem SDP für Crypto-Update
- Sipgate sendet 303 Pakete an uns ✅ (vorher immer 0!)
- **ABER OpenAI-Seite 0 Pakete.** Wahrscheinlich hat der re-offer die OpenAI-Ports
  geändert, oder OpenAI hat den Call beendet bevor Sipgate antwortete.
- **Kein Audio am Telefon.**

## Stand und nächster Schritt

**SRTP-Negotiation mit Sipgate funktioniert jetzt** (Early Offer + SAVP + Crypto).
Das SRTP-Problem ist im Prinzip gelöst. Aber das re-offer nach Sipgate's Antwort
bricht den OpenAI-Leg (0 Pakete empfangen auf OpenAI-Seite).

### Empfohlene Reihenfolge (siehe BRIEFING.md für Details):

**Phase 0 — UDP-Quick-Fix (30 Min, höchste Priorität):**
Sipgate-Registrierung von TLS:5061 auf UDP:5060 umstellen. Bei UDP ist SRTP
nicht erzwungen → plain RTP/AVP funktioniert sofort → gesamtes SRTP-Problem entfällt.
Zweites Device anlegen für Outbound, damit Inbound (TLS) nicht kaputt geht.

**Phase 1 (falls Phase 0 nicht reicht):**
Early Offer Flow reparieren: re-offer vermeiden, stattdessen OpenAI-SDP via
rtpengine so routen, dass Sipgate's echte Crypto direkt eingesetzt wird.

**Phase 2 (Langfristig):** FreeSWITCH als Alternative zu drachtio+rtpengine.
Löst SRTP-Bridging nativ mit per-Leg rtp_secure_media.

## Phase 0 — UDP-Quick-Fix (2026-04-08)

**Implementiert.** Umstellung von TLS:5061 auf UDP:5060 eliminiert das SRTP-Problem vollständig.

### Was geändert wurde

| Komponente | Vorher (TLS) | Nachher (UDP) |
|---|---|---|
| SIP-Registrierung | `sip:sip.sipgate.de;transport=tls` | `sip:sip.sipgate.de` (UDP default) |
| Contact-Header | `HETZNER_IP:5061;transport=tls` | `HETZNER_IP:5060` |
| Outbound-Flow | Early Offer (SDP im INVITE) + re-offer | Late Offer / 3PCC (kein SDP im INVITE, SDP im ACK) |
| Sipgate-Leg Crypto | SRTP erzwungen (RTP/SAVP) | Plain RTP (RTP/AVP) |
| OpenAI-Leg Crypto | SRTP (RTP/SAVP) — unverändert | SRTP (RTP/SAVP) — unverändert |
| rtpengine Bridging | SRTP ↔ SRTP (asymmetrisch kaputt) | RTP ↔ SRTP (Standard-Szenario) |

### Warum das funktioniert

Sipgate erzwingt SRTP **nur bei TLS-Signaling** (bestätigt durch sipgate.de Hilfecenter).
Bei UDP-Registrierung akzeptiert Sipgate plain RTP/AVP. rtpengine bridges
plain RTP (Sipgate) ↔ SRTP (OpenAI) — das ist der Standard-Anwendungsfall,
der zuverlässig funktioniert.

### Late Offer vs. Early Offer

Der Early-Offer-Ansatz (SDP im INVITE) erforderte einen re-offer nach Sipgate's
Antwort, um rtpengine mit Sipgate's echtem Endpoint zu aktualisieren. Dieser
re-offer brach den OpenAI-Leg (0 Pakete nach re-offer).

Late Offer (3PCC) vermeidet das Problem: Sipgate's echtes SDP geht direkt in
den ersten rtpengine.offer(). Kein re-offer nötig.

### Hetzner DNAT (verifiziert, keine Änderung nötig)

```
DNAT  udp  0.0.0.0/0 → 10.0.0.2:5060   (Lenovo1 drachtio UDP)
DNAT  tcp  0.0.0.0/0 → 10.0.0.2:5060   (Lenovo1 drachtio TCP)
DNAT  tcp  0.0.0.0/0 → 10.0.0.2:5061   (Lenovo1 drachtio TLS)
DNAT  udp  0.0.0.0/0 → 10.0.0.2:40000-40100  (rtpengine RTP)
```

### Status: AUSSTEHEND — Test erforderlich

- [ ] NanoClaw neu starten
- [ ] SIP REGISTER erfolgreich (200 OK in Logs)
- [ ] Outbound-Call testen: Angerufener hört Andy
- [ ] Inbound-Call testen: Regression-Check
- [ ] rtpengine Debug-Level von 7 auf 6 zurücksetzen

## Positive Zwischenergebnisse

1. **CT-Zonen-Fix auf Hetzner ist live und funktioniert** — bidirektionaler
   RTP-Traffic fließt, Caller-Audio erreicht OpenAI.
2. **rtpengine Debug-Level ist auf 7** — zurücksetzen auf 6 nach Abschluss.
3. **sipgate.io outgoingUrl entfernt** — kein Webhook-Eingriff mehr bei Outbound.

---

## 📌 ANMERKUNGEN VON CLAUDE-CHAT (2026-04-07, ~21:00 UTC)

Carsten hat mich (Claude im Chat-Interface) gebeten, im Web zu recherchieren, ob jemand eine Lösung für dieses Problem hat. Ergebnis und konkreter nächster-Schritt-Plan stehen in:

**`/home/carsten_bot/nanoclaw/BRIEFING.md`** (im selben Verzeichnis)

**Kurzfassung:**
- Diagnose in dieser Analyse-MD ist korrekt (durch rtpengine-Mailingliste bestätigt).
- Es gibt ein dediziertes rtpengine-Flag für genau dieses Szenario: **`OSRTP=offer`** (Opportunistic SRTP, RFC 8643). Damit muss man die callee-SDP nicht selbst manipulieren.
- Empfohlene Reihenfolge: (1) OSRTP=offer im Offer, (2) Falls Sipgate das nicht versteht: Legacy SDES=offer mit manueller SDP-Manipulation (= ursprüngliche A2), (3) Falls beides scheitert: Early Offer (Änderung B).
- Vor Aufgabe 1: bisherige Änderung A (RTP/SAVP im Answer) zurückrollen.

Details, exakter Verifikations-Plan und Scope-Grenzen → BRIEFING.md lesen.
