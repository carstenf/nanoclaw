---
name: Andy's OneCLI vault Anthropic-token sync — fixed 2026-05-12
description: sync-claude-oauth-to-onecli.sh looks up secret by name dynamically — survives delete+recreate. If Andy 401s, check path unit and log.
type: project
originSessionId: dfa58332-9972-4c31-b972-d6bb34c83afb
---
`~/bin/sync-claude-oauth-to-onecli.sh` resolves the vault secret ID by name at runtime, so it survives delete+recreate cycles (ID changes on recreate). The systemd path unit `claude-oauth-sync.path` watches `~/.claude-andy/.credentials.json` and fires on every write. `onecli secrets update --value` works; delete+recreate is only needed if the secret is missing.

**If Andy 401s:**
1. `tail ~/.claude/oauth-sync.log` — firing?
2. `systemctl --user status claude-oauth-sync.service` — failed?
3. If failed: `systemctl --user reset-failed claude-oauth-sync.service && systemctl --user start claude-oauth-sync.service`

**Emergency manual fix:**
```bash
TOKEN=$(node -e 'const j=JSON.parse(require("fs").readFileSync("/home/carsten_bot/.claude-andy/.credentials.json","utf8"));process.stdout.write(j.claudeAiOauth.accessToken)')
SECRET_ID=$(onecli secrets list | jq -r '.[] | select(.name == "Claude Max OAuth (Andy, anthropic-typed)") | .id')
onecli secrets update --id "$SECRET_ID" --value "$TOKEN"
ncl groups restart --id ag-1778351107004-eyw23u --message "Token erneuert."
```
