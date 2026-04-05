---
name: add-hindsight
description: Add Hindsight agentic memory to NanoClaw. Every conversation is stored and recalled automatically per group.
---

# Add Hindsight Memory

This skill sets up [Hindsight](https://hindsight.vectorize.io/) — a biomimetic agentic memory system — so NanoClaw automatically remembers past conversations and injects relevant context before each agent run.

Memory is scoped per group. Hindsight runs locally as a Docker container.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/hindsight.ts` exists. If it does, skip to Phase 3 (Start Hindsight).

### Check Docker is running

```bash
docker info
```

If Docker is not running, ask the user to start it before continuing.

## Phase 2: Configure env vars

Ask the user for their LLM API key (OpenAI or compatible) that Hindsight will use for embeddings:

AskUserQuestion: Which LLM provider API key should Hindsight use for embeddings? (OpenAI is recommended — paste your key)

Add the following to `.env`:

```
HINDSIGHT_URL=http://localhost:8888
HINDSIGHT_LLM_API_KEY=<key-from-user>
```

## Phase 3: Start the Hindsight container

```bash
docker compose -f docker-compose.hindsight.yml up -d
```

Verify it is running:

```bash
curl -s http://localhost:8888/health || echo "not ready yet"
```

If not ready, wait a few seconds and retry once.

## Phase 4: Build and restart NanoClaw

```bash
npm run build
```

Then restart NanoClaw:

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Send a test message to any registered group. Then send a follow-up that references something from the first message. Confirm the agent recalls it.

You can also open the Hindsight web UI at http://localhost:9999 to browse stored memories.

## Troubleshooting

- **Hindsight not responding:** Check `docker compose -f docker-compose.hindsight.yml logs hindsight`
- **No memories recalled:** The first few messages need to be stored before recall returns results. Send a few messages then test recall.
- **Disable memory for a group:** Set `HINDSIGHT_URL=` (empty) in `.env` to disable globally.
