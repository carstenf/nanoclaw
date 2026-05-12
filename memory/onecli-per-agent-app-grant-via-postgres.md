---
name: OneCLI per-agent app-grants can be set via direct postgres insert (no CLI exists)
description: When the web UI is inaccessible, insert into agent_app_connections directly; restart OneCLI app container so its cache reloads grants
type: project
originSessionId: dfa58332-9972-4c31-b972-d6bb34c83afb
---
OneCLI v1.22.0 has no CLI or API to grant an OAuth app (Gmail/Calendar/etc.) to a specific agent — the prior memory says "web-UI only". That's *almost* true, but you CAN do it via postgres if needed:

```bash
docker exec onecli-postgres-1 psql -U onecli -d onecli -c \
  "INSERT INTO agent_app_connections (agent_id, app_connection_id, updated_at) VALUES \
    ('<agent-id>', '<app-connection-id>', NOW()) \
   ON CONFLICT DO NOTHING"
```

Find the IDs with:
```bash
docker exec onecli-postgres-1 psql -U onecli -d onecli -c \
  "SELECT id, provider FROM app_connections; SELECT id, name FROM agents"
```

**Critical: OneCLI's gateway caches grants — direct DB insert is NOT picked up until the gateway restarts:**
```bash
docker restart onecli-app-1
```

Verify with: `docker exec onecli-postgres-1 psql -U onecli -d onecli -c "SELECT a.agent_id, ac.provider FROM agent_app_connections a JOIN app_connections ac ON ac.id=a.app_connection_id WHERE a.agent_id='<agent-id>'"`

**Why:** Discovered 2026-05-11 when Andy got `access_restricted` 401s for Gmail/Calendar even after successful OAuth connect of both apps in OneCLI. The web UI was hard to reach from iPhone (where the user was working); postgres insert + container restart was the fastest path.

**How to apply:** Use this when (a) web UI is impractical, (b) you're scripting agent setup, or (c) debugging "why isn't this agent allowed to use this app". Don't forget the OneCLI restart — without it, the grant exists in DB but the gateway still 401s.
