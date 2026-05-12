---
name: Anthropic Max OAuth via OneCLI for NanoClaw containers
description: How to wire a Claude Max OAuth token into a NanoClaw v2 agent via OneCLI — and the x-api-key collision that bites if you use the wrong secret type.
type: project
originSessionId: 42225b54-a6e6-49b8-b7b6-f5c6242c89ad
---
NanoClaw v2 containers run with `ANTHROPIC_API_KEY=placeholder` and rely on the OneCLI gateway to inject real credentials per request.

**Wiring:**
```bash
onecli secrets create --type anthropic --host-pattern api.anthropic.com \
  --name "Claude Max OAuth (<agent>)" --value "$TOKEN"
onecli agents set-secret-mode --id <agent> --mode selective
onecli agents set-secrets --id <agent> --secret-ids "<oauth-id>,<other-ids>"
```

**Use `--type anthropic`, not generic+Bearer.** Generic injects `Authorization: Bearer`, but the container env sets `x-api-key: placeholder` — Anthropic prefers `x-api-key` when both present → "Invalid API key". Anthropic-typed strips the inbound header and injects cleanly.

**Refresh:** token expires ~8h. `claude-oauth-sync.path` watches `~/.claude-andy/.credentials.json` and calls `sync-claude-oauth-to-onecli.sh` on every write. A 30-min timer forces `claude --print` to trigger a lazy refresh when lifetime < 90 min. See [[andy-vault-token-stale-after-refresh]].

**Stack scope:** only two Anthropic callers: Andy's containers (Max OAuth) and operator's local Claude Code (operator's own Max OAuth). Hindsight + Voice are OpenAI.
