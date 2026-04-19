# Plan 01-05b — Summary

**Status:** ✅ Completed
**Datum:** 2026-04-16
**Dependencies:** 01-05 (voice-bridge stub)

## Goal

Move `openai.realtime.calls.accept()` ownership from dead Core-sidecar-path to voice-bridge; unblock Phase 1 PASS.

## End-to-end Evidence

**Real PSTN call 2026-04-16 21:40:19 → 21:40:41 UTC (22 s conversation):**

- Caller: +491708036426 (whitelisted)
- Destination: +49308687022345 (Sipgate DID, routed via FS `openai` profile)
- Chain: Sipgate → FS external profile → FS openai profile (TLS+SRTP+PCMA) → OpenAI Realtime → webhook → Caddy → forwarder → voice-bridge `/accept` → `openai.realtime.calls.accept()` → 200 OK → audio flows
- Hangup: NORMAL_CLEARING (caller-initiated)

**Latencies:**
- FS → OpenAI INVITE to Ring-Ready: **40 ms**
- voice-bridge accept() round-trip: **389 ms**
- OpenAI 200 OK to A-leg answered: **~1.2 s**
- Bot audible greeting: confirmed by Carsten

**RTP packet counts (21:25 earlier call, 16 s window):**

| Direction | Packets | Codec |
|---|---|---|
| Sipgate → FS | 585 | PCMU |
| FS → OpenAI | 576 | PCMA (transcoded) |
| OpenAI → FS | 578 | PCMA |
| FS → Sipgate | 585 | PCMU (transcoded) |

Bidirectional, 20 ms packet cadence, no drops.

## What was deployed

**voice-bridge:**
- New POST `/accept` handler in `src/webhook.ts` — HMAC verify, whitelist check, `openai.realtime.calls.accept(callId, {model, instructions, audio.output.voice})`, `reject(486)` for non-whitelisted callers
- `buildApp()` accepts `openaiOverride` / `whitelistOverride` for vitest mocking
- `config.ts` adds `getApiKey()` (prefers `OPENAI_SIP_API_KEY`, fallback `OPENAI_API_KEY`), `getWhitelist()`, `PHASE1_PERSONA` const
- Model: `gpt-realtime-mini` per REQ-VOICE-01
- 4 new vitest cases in `accept.test.ts` (happy-path / whitelist-reject / bad-signature / non-incoming-event) — 9/9 green

**Core cleanup:**
- `src/openai-webhook.ts` deleted (legacy port 4402 listener)
- `src/freeswitch-voice.ts` reduced to minimal stub — removed `SIDECAR_URL`, `acceptViaSidecar`, `handleFSInboundWebhook`, SSE loops, `pendingFSWebhook`, `checkSidecarHealth`, `sidecarHangup`
- `src/index.ts` drops `startWebhookServer` import + call
- `makeFreeswitchCall` kept as deprecation stub (throws on call)

**voice-stack:**
- New `conf/overlay/sip_profiles/openai-profile.xml`: `tls=true`, `sip-tls-port=5062`, `tls-version=tlsv1.2`, `rtp-secure-media=true` with AEAD_AES_256_GCM_8 + fallbacks, PCMA in/out codec, bind on `$${local_ip_v4}` (NOT 127.0.0.1)
- `conf/overlay/dialplan/public/01_sipgate_inbound.xml`: bridge-string `[absolute_codec_string=PCMA]sofia/openai/sip:proj_...@sip.api.openai.com;transport=tls`

**Hetzner deploy:**
- forwarder `BRIDGE_WEBHOOK_URL` → `http://10.0.0.2:4402/accept` (force-recreated)
- TLS certs generated via `gentls_cert setup/create_server/create_client` in `/usr/local/freeswitch/certs/`

**Commits (nanoclaw repo):**
- `299c200` feat(01-05b): voice-bridge /accept + TLS openai-profile; remove legacy Core sidecar path
- `0d467c1` fix(01-05b): switch to gpt-realtime-mini per REQ-VOICE-01

## Root causes addressed (3 independent issues)

1. **Dialplan deploy-procedure bug:** FS overlay→conf copy happens only at container start. `fs_cli reloadxml` re-reads `conf/` not overlay. Plan-04 deploy (reloadxml + sofia rescan) loaded stale sip-to-ai dialplan instead of new OpenAI one. Fixed with `docker exec cp + fs_cli reloadxml` sequence.
2. **Profile-TLS prerequisite:** FreeSWITCH `sofia_glue.c:1300` throws `TLS not supported by profile` in CHANNEL-CREATE state if bridge-string uses `transport=tls` but source profile has no `<param name="tls" value="true"/>`. This is a profile-level check, not negotiated per-leg. Symptom: SIP 502 within 11 ms of `100 Trying`. Fixed by dedicated `openai` profile (Option B from briefing).
3. **Bot silence post-accept:** OpenAI account empty → `accept()` returns 200 OK (not gated by billing), but inference output silent-dropped. 578 PCMA-silence-packets in 11 s were the signature. Fixed by Carsten topping up account. Key learning: app API keys typically have no billing scope — balance-query endpoint unavailable.

## Process learnings (for Phase-1-Runbook)

**Overlay deploy procedure (correct):**
```bash
# After editing voice-stack/conf/overlay/*/<file>.xml on Lenovo1:
scp -i ~/.ssh/voice_bot_to_hetzner \
    ~/nanoclaw/voice-stack/conf/overlay/<path>/<file>.xml \
    voice_bot@10.0.0.1:/home/voice_bot/voice-stack/conf/overlay/<path>/

# Then one of:
ssh voice_bot@10.0.0.1 'docker exec vs-freeswitch cp -f \
    /overlay/<path>/<file>.xml \
    /usr/local/freeswitch/conf/<path>/<file>.xml && \
    docker exec vs-freeswitch fs_cli -x "reloadxml"'

# OR for profile changes (TLS init needs profile startup):
ssh voice_bot@10.0.0.1 'cd /home/voice_bot/voice-stack && docker compose restart freeswitch'
```

**`fs_cli reloadxml` alone is insufficient** after overlay edits — it re-reads `conf/` which won't have the new file yet.

**TLS cert setup for outbound-only TLS bridges:**
FS needs TLS-enabled profile (`tls=true`) AND a cert in the default dir `/usr/local/freeswitch/certs/` (NOT `/conf/tls/` despite the `tls-cert-dir` param name suggesting otherwise). Use `gentls_cert setup` + `create_server` + `create_client`.

**Profile bind IP affects outbound routing:**
`sip-ip=127.0.0.1` forces outbound TLS source to loopback — unreachable externally, manifests as `tport_tls_connect Invalid argument`. Use `$${local_ip_v4}` or an explicit public IP.

**OpenAI billing silence mode:**
`realtime.calls.accept()` returns 200 OK without credits, but `gpt-realtime[-mini]` inference outputs silence. Signature: constant `0xd5d5d5...` PCMA payload post-answer. No error log in bridge or FS. Only indicator: external billing check.

## Outstanding

- None blocking Phase 1 closure
- Plan 01-06 (non-autonomous PSTN acceptance tests): 1 of 3 calls done (today 21:40), 2 remaining for formal scorecard
- Balance-Alert feature → Phase-2 backlog (`.planning/BACKLOG.md`)
- Sidecar-based outbound call path (Twilio, etc.) → rebuild against voice-bridge in Phase 2
