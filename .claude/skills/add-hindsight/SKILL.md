---
name: add-hindsight
description: Add Hindsight agentic memory to NanoClaw. Every conversation is stored and recalled automatically per group. Runs as a separate docker stack with an MCP wrapper that NanoClaw connects to via the generic MEMORY_MCP_URL contract.
---

# Add Hindsight Memory

This skill sets up [Hindsight](https://hindsight.vectorize.io/) — a
biomimetic agentic memory system — so NanoClaw automatically remembers
past conversations and injects relevant context before each agent run.

NanoClaw's trunk knows nothing about Hindsight. It just speaks a generic
two-tool MCP contract (`memory_recall` + `memory_retain`) over the URL
in `MEMORY_MCP_URL`. Hindsight ships from a separate repo
([`carstenf/nanoclaw-hindsight`](https://github.com/carstenf/nanoclaw-hindsight))
as a docker stack with the matching MCP wrapper. Other memory backends
(mem0, letta, etc.) can drop in later by exposing the same two tools.

Memory is scoped per group folder.

## Phase 1: Pre-flight

### Check Docker is running

```bash
docker info
```

If Docker is not running, ask the user to start it before continuing.

### Check the MCP-wrapper stack isn't already running

```bash
docker ps --filter name=hindsight-mcp --format '{{.Names}}'
```

If a `hindsight-mcp` container is already up, skip to Phase 4 (configure NanoClaw).

## Phase 2: Clone + configure the hindsight stack

Pick an install path under the user's home (default `~/nanoclaw-hindsight/`).
The stack runs alongside NanoClaw on the same host.

```bash
git clone https://github.com/carstenf/nanoclaw-hindsight.git ~/nanoclaw-hindsight
cd ~/nanoclaw-hindsight
cp .env.example .env
```

Ask the user for the LLM API key Hindsight will use for embeddings:

> **AskUserQuestion**: Which LLM API key should Hindsight use for memory
> embeddings? (OpenAI sk-... is the typical choice — paste it. The key
> stays in `~/nanoclaw-hindsight/.env`.)

Write the answer into `~/nanoclaw-hindsight/.env`:

```
HINDSIGHT_LLM_API_KEY=<the key>
```

## Phase 3: Build + start the stack

```bash
cd ~/nanoclaw-hindsight
docker compose up -d --build
```

This starts two services:

- `hindsight` — the vectorize.io memory engine, on `127.0.0.1:4410` (API)
  and `127.0.0.1:4411` (web UI).
- `hindsight-mcp` — the streamable-HTTP MCP wrapper that NanoClaw will
  connect to, on `127.0.0.1:4412`.

Verify the wrapper:

```bash
curl -s http://localhost:4412/health
```

Expect `{"ok":true,...}`. If you get a connection error, wait 5 seconds
(Hindsight needs to initialize) and retry once. If still failing, run
`docker compose logs hindsight-mcp` and `docker compose logs hindsight`.

## Phase 4: Configure NanoClaw

Add to NanoClaw's `.env` (typically `~/nanoclaw/.env`):

```
MEMORY_MCP_URL=http://localhost:4412/mcp
```

Restart NanoClaw:

```bash
# Linux (systemd user)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Watch the NanoClaw log for the connect event:

```bash
grep memory_mcp ~/nanoclaw/logs/nanoclaw.log | tail -3
```

You should see `event: "memory_mcp_connected"` with the URL. If you see
`memory_mcp_disabled` instead, the env var isn't reaching the process —
check `data/env/env` and the systemd/launchd unit.

## Phase 5: Verify with a real conversation

Send a message to any registered group with a fact worth remembering
(e.g. "Mein Hund heißt Bello"). Wait a moment, then send a follow-up that
references it ("Wie heißt mein Hund?"). The agent should recall it.

You can also browse stored memories at <http://localhost:4411>.

## Troubleshooting

- **`memory_mcp_connect_failed` in NanoClaw log** → wrapper is down or
  unreachable. `docker ps` should list `hindsight-mcp` as running.
  `curl http://localhost:4412/health` should return ok.
- **`memory_recall_failed` after a few successful calls** → the MCP
  client lost its connection. NanoClaw logs the error but keeps running
  in no-memory mode. Restart NanoClaw to re-connect, or set up a healthcheck-driven restart on the wrapper.
- **No memories recalled** → first few messages need to land before
  recall returns results. Send 3-4 messages and try again.
- **Disable memory globally** → comment out `MEMORY_MCP_URL=` in
  `~/nanoclaw/.env` and restart NanoClaw. Hindsight stack can stay up;
  NanoClaw will just stop calling it.
- **Tear down completely** →
  ```
  cd ~/nanoclaw-hindsight && docker compose down -v
  rm -rf ~/nanoclaw-hindsight
  ```
  Then remove `MEMORY_MCP_URL` from NanoClaw `.env` and restart.
