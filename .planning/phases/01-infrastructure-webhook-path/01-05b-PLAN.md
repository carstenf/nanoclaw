phase: 01-infrastructure-webhook-path
plan: 05b
type: execute
wave: 3
depends_on: ["01-05"]
files_modified:
  - ~/nanoclaw/voice-bridge/src/webhook.ts
  - ~/nanoclaw/voice-bridge/src/config.ts
  - ~/nanoclaw/voice-bridge/src/index.ts
  - ~/nanoclaw/voice-bridge/tests/accept.test.ts
  - ~/nanoclaw/voice-bridge/package.json
  - ~/nanoclaw/src/openai-webhook.ts
  - ~/nanoclaw/src/freeswitch-voice.ts
  - ~/nanoclaw/src/index.ts
  - /home/voice_bot/voice-stack/env/forwarder.env (on Hetzner)
  - ~/.config/systemd/user/voice-bridge.service
autonomous: true
requirements:
  - REQ-DIR-01
  - REQ-DIR-03
  - AC-04
  - AC-07
tags:
  - bridge
  - openai-realtime
  - sip
  - cleanup
must_haves:
  truths:
    - "voice-bridge owns realtime.calls.accept() for Phase 1 inbound SIP calls (REQ-DIR-01)"
    - "Core has no OpenAI webhook handler on any port after cleanup (removes legacy sidecar path)"
    - "forwarder on Hetzner routes bridge_url to voice-bridge port/endpoint, not to Core :4402/openai-sip"
    - "POST /accept (voice-bridge) verifies HMAC, parses event, calls openai.realtime.calls.accept() with minimal session.update (Phase 1 persona, empty tools list per AC-04)"
    - "whitelist check lives in voice-bridge — rejects non-whitelisted via openai.realtime.calls.reject(status=486)"
    - "JSONL event call.accepted written per accept (call_id, latency_ms, openai_status)"
    - "vitest accept.test.ts: mocked OpenAI SDK, asserts accept() called with expected args on valid signed webhook; asserts reject() called for non-whitelisted caller"
    - "voice-bridge systemd unit enabled + running on 10.0.0.2:4402 (reusing port freed by Core openai-webhook removal)"
    - "tsc + vitest green on voice-bridge; tsc green on nanoclaw core after cleanup"
  artifacts:
    - path: "~/nanoclaw/voice-bridge/src/webhook.ts"
      provides: "/webhook stub retained + new /accept handler with SDK accept() + reject() logic"
      contains: "openai.realtime.calls.accept"
      min_lines: 80
    - path: "~/nanoclaw/voice-bridge/tests/accept.test.ts"
      provides: "vitest for /accept endpoint with mocked OpenAI SDK"
      contains: "vi.mock"
    - path: "~/nanoclaw/src/openai-webhook.ts"
      provides: "DELETED or reduced to empty export (legacy cleanup)"
      contains: "// removed"
    - path: "/home/voice_bot/voice-stack/env/forwarder.env"
      provides: "bridge_url points at voice-bridge /accept"
      contains: "10.0.0.2:4402/accept"
  key_links:
    - from: "forwarder (Hetzner 9876) POST /openai-sip"
      to: "voice-bridge (Lenovo1 10.0.0.2:4402) POST /accept"
    - from: "voice-bridge /accept handler"
      to: "openai.realtime.calls.accept() (outbound to OpenAI API)"

steps:
  - id: A
    title: "Read current state"
    actions:
      - "grep for VOICE_SIDECAR_URL, acceptViaSidecar, handleFSInboundWebhook, :4500 in src/"
      - "inspect voice-bridge/src/ current surface"
      - "inspect forwarder.env on Hetzner for bridge_url"
    output: "Notes in working context; no files touched."

  - id: B
    title: "Extend voice-bridge: /accept endpoint"
    actions:
      - "Edit src/webhook.ts: add registerAcceptRoute(app, openai, log, secret, whitelist)"
      - "Handler: addContentTypeParser already captures rawBody. Verify HMAC via openai.webhooks.unwrap"
      - "Extract callerNumber from event.data.sip_headers.From (fallback: event.data.caller_number)"
      - "If !whitelist.has(callerNumber): openai.realtime.calls.reject(call_id, {status_code: 486}); log event reject_whitelist; return 200"
      - "Else: openai.realtime.calls.accept(call_id, {model: 'gpt-4o-realtime-preview', instructions: PHASE1_PERSONA, tools: [], voice: 'cedar'}); log event call_accepted with latency; return 200"
      - "Errors from accept(): log event accept_failed with error; return 200 (webhook ack) but don't raise"
    output: "webhook.ts with new /accept route"

  - id: C
    title: "Bridge config: OpenAI API key + whitelist"
    actions:
      - "src/config.ts: add getApiKey() reading OPENAI_API_KEY with lazy validation (same pattern as getSecret)"
      - "src/config.ts: add getWhitelist() reading INBOUND_CALLER_WHITELIST (csv E.164) → Set<string>; empty set = reject all"
      - "src/index.ts: new OpenAI({ apiKey: getApiKey(), webhookSecret: getSecret() }) — remove 'not-used' dummy"
      - "registerAcceptRoute(app, openai, log, secret, getWhitelist())"
    output: "config.ts + index.ts wired with real API key + whitelist"

  - id: D
    title: "Bridge test: accept.test.ts"
    actions:
      - "Add tests/accept.test.ts: build app, inject valid signed webhook for realtime.call.incoming, mock openai.realtime.calls.accept, assert called with call_id + expected instructions"
      - "Second test: non-whitelisted caller → assert reject() called with 486"
      - "Third test: invalid signature → 401, neither accept nor reject called"
    output: "accept.test.ts green locally"

  - id: E
    title: "Core cleanup"
    actions:
      - "src/openai-webhook.ts: delete file entirely (or reduce to empty module for rebuild safety)"
      - "src/freeswitch-voice.ts: remove acceptViaSidecar, acceptOpenAICallForOutbound, handleFSInboundWebhook, SIDECAR_URL const, checkSidecarHealth, connectSidecarSse, connectCallSse, scheduleSseReconnect, sidecarReady state, sidecarHangup — all sidecar-dependent code"
      - "src/freeswitch-voice.ts: remove pendingFSWebhook Map + all refs (it was the bridge to openai-webhook)"
      - "src/freeswitch-voice.ts: initFreeswitchVoice — drop sidecar health poll + SSE connect; keep voiceDeps wiring"
      - "src/index.ts: remove startWebhookServer import + call"
      - "src/config.ts (env loader): remove VOICE_SIDECAR_URL from loaded env-vars"
      - "Verify: grep -rE 'SIDECAR_URL|acceptViaSidecar|handleFSInboundWebhook|pendingFSWebhook|:4500' src/ → empty"
      - "npm run build — tsc must stay green"
    output: "Core without legacy sidecar refs; build green"

  - id: F
    title: "Forwarder reroute on Hetzner"
    actions:
      - "Read /home/voice_bot/voice-stack/env/forwarder.env via SSH"
      - "Change BRIDGE_URL (or equivalent) from http://10.0.0.2:4402/openai-sip to http://10.0.0.2:4402/accept"
      - "docker compose -f /home/voice_bot/voice-stack/docker-compose.yml restart webhook-forwarder"
      - "Verify: docker logs vs-webhook-forwarder --since 30s | grep 'bridge_url' → new URL"
    output: "Forwarder relays to voice-bridge /accept"

  - id: G
    title: "Deploy voice-bridge + verify port conflict gone"
    actions:
      - "Port 4402 on Lenovo1: formerly Core openai-webhook. After step E, Core no longer binds 4402. Verify: ss -tlnp | grep :4402 → nothing"
      - "systemctl --user start voice-bridge (or install unit if missing)"
      - "Verify: ss -tlnp | grep :4402 → bridge node process listening"
      - "curl http://10.0.0.2:4402/health → 200 + json"
    output: "voice-bridge live on 4402"

  - id: H
    title: "Synthetic accept test"
    actions:
      - "From Hetzner: craft signed webhook with event=realtime.call.incoming, caller=+491708036426 (whitelisted)"
      - "POST to https://mcp.carstenfreek.de/sipgate-voice/openai-sip → 200"
      - "Verify JSONL: grep call_accepted in voice-bridge log; openai accept() call in log"
      - "Check if synthetic call_id appears in OpenAI realtime dashboard (or accept returns 200)"
    output: "Test green or precise error logged for debug"

  - id: I
    title: "Documentation"
    actions:
      - "state-repo: decisions/2026-04-16-sidecar-removal-bridge-accept.md"
      - "voice-channel-spec/REQUIREMENTS.md: refine REQ-DIR-01 (explicit 'Bridge owns realtime.calls.accept')"
      - "01-05-SUMMARY.md (or new 01-05b-SUMMARY.md) updated"
      - "Phase-1 runbook append: 'Deploy overlay → cp into container + restart' rule from earlier finding"
    output: "Docs committed with code"

rollback:
  - "git revert deploy commit on nanoclaw repo"
  - "restore forwarder.env BRIDGE_URL to old /openai-sip"
  - "systemctl --user stop voice-bridge"
  - "restart nanoclaw core (takes back 4402)"
  - "openai-webhook.ts will be restored via git revert"

acceptance:
  - "vitest suite in voice-bridge green (including new accept.test.ts)"
  - "tsc green on nanoclaw core"
  - "ss -tlnp on Lenovo1 shows :4402 bound by voice-bridge (not core)"
  - "synthetic webhook from H reaches voice-bridge AND openai.accept() mock/real succeeds"
  - "Real PSTN call from Carsten (deferred to 01-06): FS bridges, OpenAI accepts, Carsten hears NanoClaw persona response"

notes:
  - "Port 4401 (Core Twilio voice-server) unchanged — independent code path"
  - "Core no longer has any inbound-call-acceptance logic; all webhook handling lives in voice-bridge"
  - "whitelist check moved from Core to voice-bridge — env INBOUND_CALLER_WHITELIST shared (currently set on Lenovo1 in ~/nanoclaw/.env; bridge runs on Lenovo1 too so it can read same .env via process.env if systemd unit uses EnvironmentFile=)"
  - "Phase 2 scope: Bridge receives tool-call events via SSE, proxies to Core for business logic — that is REQ-DIR-04+ not touched here"
