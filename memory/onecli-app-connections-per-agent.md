---
name: OneCLI app-connections require per-agent grant
description: Connecting an OAuth app (Gmail/Calendar/Drive) only stores the tokens — each agent still needs explicit grant via the web UI before its container can use them
type: project
originSessionId: 07a163f5-028f-460c-875b-2cc088576b1c
---
OneCLI v1.22.0 has two distinct authorization layers:

1. **App configuration + OAuth connection** — done once globally per app (Gmail, Calendar, Drive, etc.). Stores OAuth client credentials and the user's connected Google account in the vault. UI: `https://onecli.carstenfreek.de/connections?connect=<app>`.
2. **Per-agent app-grant** — each agent must be explicitly granted access to each connected app. Without this, the gateway returns `access_restricted` even though the credentials exist in the vault.

**Symptom of missing grant:** when an agent's container calls `gmail.googleapis.com` (or similar), the OneCLI gateway responds with:
```json
{"error":"access_restricted","manage_url":"http://localhost:10254/agents?manage=<agent-id-prefix>","message":"Gmail credentials exist in OneCLI but this agent does not have access. Ask the user to grant access: ..."}
```

**Grant path (browser, via Caddy):** `https://onecli.carstenfreek.de/agents?manage=<full-agent-id>` — toggle access to each app for this agent.

**Verification:** `curl http://127.0.0.1:10254/api/agents | jq '.[] | select(.id=="<agent-id>") | ._count.agentAppConnections'` — increments by 1 per granted app.

**Why:** `agentAppConnections` is a real Prisma relation in OneCLI's schema, but no CLI subcommand and no documented API endpoint exposes it as of v1.22.0. Web UI is currently the only way to manage it. Don't waste time hunting for `onecli apps grant --agent X` — it doesn't exist yet.

**How to apply:**
- Whenever connecting a new OAuth app (Gmail, Calendar, Drive, GitHub, etc.) for an agent, do BOTH: web-UI connect (one-time per app), then web-UI grant (once per agent×app combination).
- For Andy specifically (`ag-1778351107004-eyw23u`, OneCLI id `f5abe959-c845-4166-83d5-8cf5fced7e0a`): grant URL is `https://onecli.carstenfreek.de/agents?manage=f5abe959-c845-4166-83d5-8cf5fced7e0a`.
