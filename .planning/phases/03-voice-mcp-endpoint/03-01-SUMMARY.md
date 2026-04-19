# 03-01 SUMMARY — Voice-MCP-Endpoint live

**Datum:** 2026-04-17
**Plan:** `.planning/phases/03-voice-mcp-endpoint/03-01-PLAN.md`
**Status:** DONE — alle Tasks ausgefuehrt, live-smoke PASS.
**Commits (nanoclaw repo):** `791ad5d` (feat) + `78eccdc` (prettier-reformat)
**Grundlage:** state-repo 33ca2d4 (Plan), 69e3b75 + 97b4bef + 30af962 (Chat-Entscheidungen), d5c0668 (GO)

---

## Was gebaut wurde

| Modul | Datei | Zweck |
|---|---|---|
| Peer-Allowlist | `src/peer-allowlist.ts` | Express-Middleware, IPv6-Mapping-Normalisierung, fail-safe |
| Tool-Registry | `src/mcp-tools/index.ts` | `ToolRegistry` + `buildDefaultRegistry`, `UnknownToolError` |
| Voice-Handler | `src/mcp-tools/voice-on-transcript-turn.ts` | Input-Validation (`BadRequestError`), JSONL-Log mit `transcript_len` |
| MCP-Server | `src/mcp-server.ts` | Express-App, bind `10.0.0.2:3200`, `/health` + `/mcp/:tool_name` |
| Wiring | `src/index.ts` | `startMcpServer()` nach `initFreeswitchVoice()` |

Env-Defaults: `MCP_SERVER_PORT=3200`, `MCP_SERVER_BIND=10.0.0.2`, `MCP_PEER_ALLOWLIST=10.0.0.1,10.0.0.4,10.0.0.5`.

Task 01 (env.ts-Erweiterung) war **No-op**: nanoclaw's env.ts ist kein Zod-Schema, sondern eine `readEnvFile(['KEY'])`-Helper. Defaults wurden stattdessen inline in `mcp-server.ts` gesetzt — matcht Konvention aus `voice-server.ts` und `config.ts`. Deviation dokumentiert, gleiche Semantik.

---

## Port-Binding-Evidence (Lenovo1 `ss -tlnp`)

```
LISTEN 10.0.0.2:3200       users:(("node",pid=251501,fd=28))  ← neu (MCP)
LISTEN 10.0.0.2:4402       users:(("node",pid=206336,fd=31))
LISTEN 0.0.0.0:4401        users:(("node",pid=251501,fd=27))  ← voice-server
```

Bind korrekt auf `10.0.0.2:3200` (NICHT `0.0.0.0`). Gleicher Node-Prozess (PID 251501) wie voice-server — Variante 1 (zweiter Listener im bestehenden `nanoclaw.service`) bestaetigt.

---

## Live-Smoke-Evidence (von Hetzner 10.0.0.1)

### `GET /health`

```bash
$ curl -sS http://10.0.0.2:3200/health
{"ok":true,"ts":1776443369457,"bound_to":"10.0.0.2:3200",
 "peers":["10.0.0.1","10.0.0.4","10.0.0.5"],
 "tools":["voice.on_transcript_turn"]}
```

### `POST /mcp/voice.on_transcript_turn`

```bash
$ curl -sS -X POST -H 'Content-Type: application/json' \
    -d '{"arguments":{"call_id":"smoke-1","turn_id":"t0","transcript":"live smoke test"}}' \
    http://10.0.0.2:3200/mcp/voice.on_transcript_turn
{"ok":true,"result":{"ok":true,"instructions_update":null}}
```

### JSONL-Log `data/voice-slow-brain.jsonl`

```
{"ts":1776443375506,"event":"transcript_turn_received","call_id":"smoke-1","turn_id":"t0","transcript_len":15}
```

`transcript_len=15` ist die Byte-Laenge von `"live smoke test"`. Kein Klartext geloggt — PII-Schutz wie in Plan gefordert.

### Peer-Allowlist-Block (Negativ-Test)

Lokal von Lenovo1 aus (source-IP `10.0.0.2`, **nicht** in Allowlist):

```
$ curl -sS http://10.0.0.2:3200/health
{"error":"peer_not_allowed","peer_ip":"10.0.0.2"}
```

403-Response korrekt. Nur Peers aus `MCP_PEER_ALLOWLIST` kommen durch.

---

## Test-Matrix (23 neue Tests, alle gruen)

| Suite | Cases | Inhalt |
|---|---:|---|
| `src/peer-allowlist.test.ts` | 7 | IPv6-Normalisierung (3), Allow/Block/IPv6-Mapping/empty-allowlist (4) |
| `src/mcp-tools/voice-on-transcript-turn.test.ts` | 9 | Input-Validation (4) + Handler-Verhalten (3) + Registry (2) |
| `src/mcp-server.test.ts` | 7 | /health happy+block, POST happy/unknown/bad-json/bad-request/blocked-peer |

`npx tsc --noEmit` clean. Full suite: 351 passed / 1 failed — die Failure ist `src/channels/gmail.test.ts buildQuery` und existierte **vor** dieser Phase (git log commit `ec0385e`, unabhaengig).

---

## Abweichungen vom Plan

1. **Task 01 No-op**: env.ts wurde nicht erweitert (kein Zod-Schema im repo). Defaults inline in mcp-server.ts via `readEnvFile()`. Semantisch identisch.
2. **supertest nicht im Repo**: Tests nutzen Node-builtin `fetch()` gegen `http.createServer().listen(0, '127.0.0.1')` statt supertest. Kein Dep-Add noetig.
3. **Verify Task 06 Step 4 (Hetzner-cross-host)** wurde ueber `mcp__claude_ai_Hetzner__exec` gefahren statt ssh — Ergebnis identisch.

---

## Follow-up — Plan 03-02 Scope

`voice.on_transcript_turn` ist heute ein Stub: `instructions_update: null`. Plan 03-02 (separater Plan im selben Phase-Verzeichnis) soll den Stub durch eine echte Claude-Slow-Brain-Integration ersetzen:

- Option A: Container-Agent pro call_id mit persistent Memory (Hindsight)
- Option B: Leichtgewichtige Claude-API-Call mit call_id-spezifischem Kontext
- Option C: Integration mit bestehender NanoClaw-Agent-Runtime (Container)

Chat-Entscheidung in 03-02 noetig. Nicht scope von 03-01.

---

## Plan 02-09 Freigabe

Plan 02-09 kann jetzt ausgefuehrt werden. Naechste Schritte:

1. Plan 02-09 Frontmatter `autonomous: false` → `autonomous: true` setzen.
2. `voice-bridge/.env` auf Hetzner um `CORE_MCP_URL=http://10.0.0.2:3200/mcp` erweitern.
3. `/gsd-execute-phase 02-director-bridge-v0-hotpath-safety` oder direkt 02-09 inline ausfuehren.
4. Nach 02-09: Live-PSTN-Test, mid-call `session.update` sollte `instructions_update:null` sehen (Stub-Verhalten aus 03-01) — also keinerlei Updates. Das ist korrekt bis 03-02 landet.

---

## Commit-Hashes

| Repo | Commit | Scope |
|---|---|---|
| state-repo | `33ca2d4` | Plan 03-01 (nach Chat-Korrekturen) |
| state-repo | TBD | Dieses SUMMARY |
| nanoclaw | `791ad5d` | feat: MCP-Server + Tools + Wiring (23 Tests) |
| nanoclaw | `78eccdc` | style: prettier-reformat |
