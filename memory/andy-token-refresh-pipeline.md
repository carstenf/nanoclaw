---
name: Andy Max-OAuth token refresh pipeline (the "second brain login")
description: How Andy's separate Claude Max account is wired, refreshed, and synced into OneCLI — files involved and key gotchas.
type: project
originSessionId: 42225b54-a6e6-49b8-b7b6-f5c6242c89ad
---
Andy runs on a SEPARATE Claude Max OAuth login from the operator. Credentials live in `~/.claude-andy/.credentials.json`. A pipeline keeps OneCLI's anthropic vault entry in sync, and a systemd timer schedules forced re-logins every 5 days.

**Why:** shared token exhausts rate limit; refresh-token has ~1 week server-side lifetime.

**Pipeline files (Lenovo1, carsten_bot):**

- `~/bin/claude-andy-login.py` — pexpect TUI driver. Bracketed-paste sends the auth code (`\x1b[200~code\x1b[201~\r`). Phase 1 sends 6 blind Enters through theme picker; do NOT send `1\r` after `/login`. Waits up to 10 min for credentials.json. Strips ANSI escapes + CRLF soft-wraps before URL regex (TUI wraps long URLs mid-line with color resets).
- `~/bin/refresh-andy-token.sh` — orchestrator (`--now` / `--status`). Posts OAuth URL as Discord Link-Button component (plain URLs and embed.title stopped being clickable on mobile). State-matches Discord reply to URL's `state=` param to reject stale codes.
- `~/bin/sync-claude-oauth-to-onecli.sh` — syncs accessToken into OneCLI vault. Looks up secret by name (not hardcoded ID). See [[andy-vault-token-stale-after-refresh]].
- `~/.config/systemd/user/refresh-andy-token.timer` — `OnUnitActiveSec=5d`, `Persistent=false` (no catch-up on reboot).
- `~/.config/systemd/user/refresh-andy-now.{path,service}` — Andy touches `/workspace/extra/refresh-control/now`; path-unit fires orchestrator. Uses `PathExists`; auto-removes flag in `ExecStartPre`.
- `/tmp/refresh-control/` — mounted into Andy's container at `/workspace/extra/refresh-control/` RW. Allowlisted in `~/.config/nanoclaw/mount-allowlist.json`.
- `container/skills/refresh-andy-token/instructions.md` — operationally self-sufficient fragment (trigger words + bash one-liners inlined). Fragments that say "go read the skill" don't override strong default priors — operational content must be inline.

**Key gotchas:**

- **Mount-allowlist is in-memory cached** — adding a path requires `systemctl --user restart nanoclaw` to reload; silent REJECT otherwise.
- **NEVER `rm -rf ~/.claude-andy`** — credentials.json may have just been written even if login looked failed.
