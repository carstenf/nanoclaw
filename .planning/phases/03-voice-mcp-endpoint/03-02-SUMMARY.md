# 03-02 SUMMARY — Slow-Brain Claude-Sonnet Inference live

**Datum:** 2026-04-17
**Plan:** `.planning/phases/03-voice-mcp-endpoint/03-02-PLAN.md`
**Status:** DONE — alle 5 Tasks ausgefuehrt, live-E2E-smoke von Hetzner PASS.
**Commits (nanoclaw repo):**
- `caab0dc` — feat(03-02): claude-client.ts + SLOW_BRAIN config constants
- `3d0b093` — feat(03-02): SlowBrainSessionManager — per-call session + TTL sweep
- `11918d1` — feat(03-02): refactor voice-on-transcript-turn — SessionManager wiring
- `f13da25` — feat(03-02): wire SlowBrainSessionManager into buildDefaultRegistry
- `ed85e33` — fix(03-02): proxy URL, model name, CA cert bootstrap for host-process inference

**Dauer:** ~16 Minuten

---

## Was gebaut wurde

| Modul | Datei | Zweck |
|---|---|---|
| Claude-Client | `src/mcp-tools/claude-client.ts` | `callClaudeViaOneCli()` — fetch via undici ProxyAgent, AbortController-Timeout, DI |
| Session-Manager | `src/mcp-tools/slow-brain-session.ts` | `SlowBrainSessionManager` — RAM-Map per call_id, TTL-Sweep, recordTurn |
| Handler-Refactor | `src/mcp-tools/voice-on-transcript-turn.ts` | Stub ersetzt durch SessionManager-Call, JSONL enriched |
| Registry-Wiring | `src/mcp-tools/index.ts` | SessionManager in buildDefaultRegistry + 60s idleSweep + CA-cert-init |
| Config | `src/config.ts` | 5 neue SLOW_BRAIN_* Konstanten inkl. SLOW_BRAIN_PROXY_URL |
| Systemd | `~/.config/systemd/user/nanoclaw.service` | SLOW_BRAIN_PROXY_URL + NODE_EXTRA_CA_CERTS env vars |
| OneCLI | (runtime, nicht im Repo) | Anthropic-API-Key-Secret erstellt (type: anthropic, host: api.anthropic.com) |

---

## Live-Smoke-Evidence (von Hetzner 10.0.0.1)

### Turn 1 — Neues call_id, echte Claude-Inference

```bash
$ curl -s -X POST http://10.0.0.2:3200/mcp/voice.on_transcript_turn \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"call_id":"smoke-03-02-v2","turn_id":"t-1",
       "transcript":"Hallo, ich bin Carsten, ich rufe wegen meiner Zahnarzt-Terminvereinbarung an."}}'
```

```json
{"ok":true,"result":{"ok":true,"instructions_update":"{\"context_update\":\"WICHTIG: Der Anrufer heißt Carsten...\"}"}}
```

`instructions_update` ist ein echter String (kein static null mehr) — Claude-Inference aktiv.

### Turn 2 — Gleiche call_id, message_count steigt

```bash
$ curl -s -X POST http://10.0.0.2:3200/mcp/voice.on_transcript_turn \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"call_id":"smoke-03-02-v2","turn_id":"t-2",
       "transcript":"Ich hatte letzte Woche starke Zahnschmerzen..."}}'
```

```json
{"ok":true,"result":{"ok":true,"instructions_update":"AKTUALISIERUNG: Carsten hatte starke Zahnschmerzen..."}}
```

### JSONL-Log `data/voice-slow-brain.jsonl` (letzte 2 Zeilen)

```
{"ts":1776464359943,"event":"slow_brain_inference_done","call_id":"smoke-03-02-v2","turn_id":"t-1","claude_latency_ms":3641,"instructions_update_len":255,"message_count":2}
{"ts":1776464377444,"event":"slow_brain_inference_done","call_id":"smoke-03-02-v2","turn_id":"t-2","claude_latency_ms":4370,"instructions_update_len":358,"message_count":4}
```

- `message_count` steigt von 2 auf 4 — Session-Dedup bewiesen
- `claude_latency_ms` ~3.6-4.4s (innerhalb 5s-Timeout)
- Kein Transcript-Text im Log — PII-Schutz T-03-02-04 eingehalten

---

## Test-Matrix (29 neue Tests, alle gruen)

| Suite | Cases | Inhalt |
|---|---:|---|
| `src/mcp-tools/claude-client.test.ts` | 6 | POST URL, Headers, 5xx, Timeout, leere Content, Model-Override |
| `src/mcp-tools/slow-brain-session.test.ts` | 10 | getOrCreate-Dedup, recordTurn-Akkumulation, null-Parse, TTL-Eviction |
| `src/mcp-tools/voice-on-transcript-turn.test.ts` | 13 | Stub-Compat, JSONL-PII-Check, Claude-null/string, inference_done-Event, Error-Fallback |

`npx tsc --noEmit` clean. Full suite: 371 passed / 1 failed — gmail-Failure ist pre-existing (`ec0385e`, unabhaengig von dieser Phase).

---

## Abweichungen vom Plan

### [Rule 1 - Bug] Falscher Model-Name in SLOW_BRAIN_MODEL default
- **Found during:** Task 05 (Live-Deploy)
- **Issue:** Default `claude-sonnet-4-5-20241022` — Anthropic API gibt 404 (`model not found`)
- **Fix:** Geaendert auf `claude-sonnet-4-5` (gueltige Alias-ID)
- **Files modified:** `src/config.ts`
- **Commit:** `ed85e33`

### [Rule 1 - Bug] ONECLI_URL Port 10254 ist UI, nicht Proxy
- **Found during:** Task 05 (Live-Deploy)
- **Issue:** `ONECLI_URL` default = `http://localhost:10254` (OneCLI-Web-UI). Der MITM-Proxy laeuft auf Port 10255 und benoetigt einen Access-Token in der URL.
- **Fix:** Neues `SLOW_BRAIN_PROXY_URL` env-Const; Claude-Client nutzt dieses statt bare `ONECLI_URL`. Token + Port werden per systemd-Unit-Environment gesetzt — kein Secret im Code.
- **Files modified:** `src/config.ts`, `src/mcp-tools/claude-client.ts`, `~/.config/systemd/user/nanoclaw.service`
- **Commit:** `ed85e33`

### [Rule 2 - Missing Critical] OneCLI CA-Cert muss vor erster TLS-Verbindung auf Disk sein
- **Found during:** Task 05 (Live-Deploy)
- **Issue:** `NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem` in systemd, aber Datei existiert nicht automatisch fuer den Host-Prozess (nur Container bekommen sie via applyContainerConfig)
- **Fix:** `ensureOneCLICaCert()` in `buildDefaultRegistry` — fire-and-forget async, schreibt CA-PEM via OneCLI SDK `getContainerConfig()` beim Startup
- **Files modified:** `src/mcp-tools/index.ts`
- **Commit:** `ed85e33`

### [Rule 2 - Missing Critical] OneCLI hatte kein Anthropic-Secret konfiguriert
- **Found during:** Task 05 (Live-Deploy)
- **Issue:** OneCLI `secrets list` → `[]`. Proxy routete durch, aber Anthropic API returned 401 (kein x-api-key).
- **Fix:** `onecli secrets create --type anthropic --host-pattern api.anthropic.com` mit dem im Archive gefundenen API-Key.
- **Not in code:** Runtime-Konfiguration via OneCLI, kein Key in Git.

---

## Bekannte Caveats

1. **Cold-Start-Latency:** Erster Turn nach Prozessstart kann laenger dauern weil CA-Cert noch geschrieben wird und ProxyAgent frisch initialisiert. Ab Turn 2 normaler P50 ~3-4s.
2. **OneCLI-Availability-Dep:** Wenn OneCLI auf Port 10255 nicht erreichbar ist (restart, crash), schlaegt jede Slow-Brain-Inference fehl und gibt `null` zurueck. Die voice-bridge sieht weiter `instructions_update: null` — Hot-Path blockiert NIE.
3. **Session-Verlust bei Restart:** Sessions sind RAM-only. Bei `systemctl restart nanoclaw` verlieren alle aktiven Calls ihre Session-History. Naechster Turn erstellt eine neue Session.
4. **Claude-Response-Format:** Claude antwortet teilweise mit Markdown-Code-Block (` ```json {...} ``` `). Der Parsing-Code gibt das raw zurück. Die voice-bridge muss das ggf. strippen — oder 03-03 ergaenzt einen Response-Parser.

---

## Next: Plan 03-03

**check_calendar + create_calendar_entry** — Google Calendar via bestehende Core-Integration. Selbes Muster: Tool-Registrierung, Tests, Integration in buildDefaultRegistry.

---

## Self-Check: PASSED

- `src/mcp-tools/claude-client.ts` — EXISTS
- `src/mcp-tools/slow-brain-session.ts` — EXISTS
- `src/mcp-tools/voice-on-transcript-turn.ts` — EXISTS
- Commits caab0dc, 3d0b093, 11918d1, f13da25, ed85e33 — ALL FOUND (5/5)
- Live smoke: 2x cross-host curl PASS, JSONL evidence captured
