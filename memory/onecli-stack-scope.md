---
name: OneCLI stack lives in carsten_bot scope
description: ~/.onecli/docker-compose.yml is owned by carsten_bot — updates/restarts don't need an ASK FOR CHAT
type: project
originSessionId: 07a163f5-028f-460c-875b-2cc088576b1c
---
OneCLI runs as a docker-compose stack under `~/.onecli/` (carsten_bot's home), not as a system service under user `carsten`. The `process owner` in `ps aux` shows uid 1000 (`carsten`) only because of container uid-mapping — that does NOT mean the stack is in carsten's scope.

**Why:** discovered 2026-05-10 when I (carsten_bot) opened an `ASK FOR CHAT` to update OneCLI from 1.11.0 → 1.22.0. Chat-Claude executed it but flagged: the compose.yml is owned by carsten_bot. I could have done the update myself.

**How to apply:**
- Routine OneCLI version updates, secret/agent CRUD, and container restarts (`docker compose pull/up/down` in `~/.onecli/`) are in-scope for carsten_bot. No ASK needed.
- Backup the secret-encryption-key tarball + pg_dump + compose.yml.bak before any update — encrypted secrets in the DB are unrecoverable without the key.
- When deciding scope, ask "who owns the compose.yml / config files" not "who runs the container process" — uid-mapping confuses the latter.
- Still ASK FOR CHAT for: changes to system-level OneCLI config (Caddy routing, systemd units), or anything outside `~/.onecli/`.
