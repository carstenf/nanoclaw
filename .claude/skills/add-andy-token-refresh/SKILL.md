---
name: add-andy-token-refresh
description: Install the auto-refresh mechanism for an Andy-style agent that uses a separate Claude Max OAuth account. Sets up the host wrapper, systemd timer (default 5 days, ON), path-watchers for conversational triggers, and the container skill that lets Andy run touch-flag bash to trigger refreshes. Prerequisite — the agent must already have its own ~/.claude-andy/.credentials.json from a one-time `CLAUDE_CONFIG_DIR=~/.claude-andy claude login`.
---

# Add Andy Token-Refresh

Wires up automatic + on-demand refresh of the Claude Max OAuth account
backing an Andy-style NanoClaw agent. The mechanism has three loosely-
coupled pieces:

1. **Host wrapper** (`~/bin/refresh-andy-token.sh`) — orchestrates a fresh
   `claude login` (via the pexpect helper `~/bin/claude-andy-login.py`),
   posts the OAuth URL to Discord as a **Link-Button component**
   (`type=2, style=5`) inside a context embed — plain `embed.title`-as-
   hyperlink was unreliable on Discord mobile clients (silent A/B). The
   raw URL is also appended to the message content as a long-press
   fallback. Polls Discord for the auth code, pipes it into the waiting
   TUI, waits for credentials.json, triggers the OneCLI vault sync.

2. **Systemd timer** (`refresh-andy-token.timer`) — fires every 5 days. The
   refresh-token from a Max login lives ~1 week; 5 days gives a 2-day
   buffer. `Persistent=false` on purpose — never run "to catch up" after
   reboots, only forward.

3. **Conversational triggers via mount** — Andy's container mounts
   `/tmp/refresh-control/` as RW. A path-unit on the host watches for
   `/tmp/refresh-control/now` and runs the wrapper when it appears. Andy
   reads the status from `status.json` in the same directory. The
   container-side skill (`container/skills/refresh-andy-token/`) gives
   Andy the four bash one-liners.

## Phase 1: Pre-flight

### 1.1 Verify the agent has a separate credentials file

```bash
ls -la ~/.claude-andy/.credentials.json
```

If missing: run a one-time login first. Two options:

- **Manual** — `CLAUDE_CONFIG_DIR=~/.claude-andy claude` in a TTY,
  click through onboarding, type `/login`, click the URL, paste the
  auth-code. Done.
- **Automated** — use `~/bin/claude-andy-login.py` (the pexpect helper).
  It captures the URL into `/tmp/claude-andy-url.txt`, waits for
  `/tmp/claude-andy-code.txt`, pipes via bracketed paste. Operator just
  posts URL via curl-Discord and reads the code from Discord.

### 1.2 Verify the OneCLI vault has an entry the agent uses

```bash
onecli secrets list | jq '.[] | {id, name, hostPattern}'
```

You need one with `hostPattern: "api.anthropic.com"` and `type: "anthropic"`
that the target agent has assigned (selective mode). The wrapper updates
this entry's value on every successful refresh.

### 1.3 Verify the file-watcher path-unit exists

```bash
systemctl --user is-active claude-oauth-sync.path
```

Should be `active`. If not, set up the credentials → vault sync first
(small bash script + path-unit watching `~/.claude-andy/.credentials.json`).

## Phase 2: Install host-side scaffolding

The pieces are already in this repo. Copy / verify:

- `~/bin/refresh-andy-token.sh` (executable)
- `~/bin/claude-andy-login.py` (executable, pexpect helper)
- `~/bin/sync-claude-oauth-to-onecli.sh` (the existing sync script,
  pointed at `~/.claude-andy/.credentials.json`)
- `~/.config/systemd/user/refresh-andy-token.service`
- `~/.config/systemd/user/refresh-andy-token.timer` (`OnUnitActiveSec=5d`,
  `Persistent=false`)
- `~/.config/systemd/user/refresh-andy-now.path` + `.service` (watches
  `/tmp/refresh-control/now`)
- `~/.config/systemd/user/claude-oauth-sync.path` + `.service` (watches
  `~/.claude-andy/.credentials.json`)

```bash
mkdir -p /tmp/refresh-control
systemctl --user daemon-reload
systemctl --user enable --now refresh-andy-token.timer
systemctl --user enable --now refresh-andy-now.path
systemctl --user enable --now claude-oauth-sync.path
```

## Phase 3: Mount + allowlist

Edit the agent group's `container.json`:

```json
{
  "additionalMounts": [
    {
      "hostPath": "/tmp/refresh-control",
      "containerPath": "refresh-control",
      "readonly": false
    }
  ]
}
```

Add the same path to `~/.config/nanoclaw/mount-allowlist.json` with
`allowReadWrite: true`. Without the allowlist entry, NanoClaw will
silently drop the mount at container spawn (you'll see
`Additional mount REJECTED` in `logs/nanoclaw.error.log`).

## Phase 4: Container skill

The skill `container/skills/refresh-andy-token/SKILL.md` ships in this
repo and is auto-mounted into every NanoClaw container at `/app/skills/`.
Andy discovers it via the Skill tool — when the operator asks for a
refresh, Andy reads the skill and runs the bash one-liner.

No per-agent activation needed; if the skill directory is present, every
container with the mount sees it.

## Phase 5: Smoke-test

### 5.1 Status query (no side-effects)

```bash
~/bin/refresh-andy-token.sh --status | jq .
```

Should print a JSON with `current_token_expires_at`, `timer_state=active`,
`timer_next_run` ~5 days out.

### 5.2 Trigger a real refresh manually

```bash
touch /tmp/refresh-control/now
sleep 3
journalctl --user -u refresh-andy-now.service -n 20 --no-pager
```

The path-unit fires the service, the wrapper posts the Discord message
(embed + clickable Link-Button), the operator taps + autorisiert +
pastes the code back into the channel, and within 2-3 minutes
`~/.claude-andy/.credentials.json` is fresh and the OneCLI vault is
synced.

### 5.3 Verify Andy can trigger from within his container

In Andy's chat, ask: "Andy, refresh dein Token jetzt." Andy should run
`touch /workspace/extra/refresh-control/now`. Verify the host's
`refresh-andy-now.service` fires (same journalctl as 5.2).

## Pause / resume / change interval

```bash
# pause auto-refresh (manual refresh-now still works)
systemctl --user stop refresh-andy-token.timer
systemctl --user disable refresh-andy-token.timer

# resume
systemctl --user enable --now refresh-andy-token.timer

# change interval (e.g. to 6 days)
systemctl --user edit refresh-andy-token.timer
# add:
#   [Timer]
#   OnUnitActiveSec=6d
systemctl --user daemon-reload
systemctl --user restart refresh-andy-token.timer
```

## Tear down

```bash
systemctl --user disable --now refresh-andy-token.timer refresh-andy-now.path
rm -f ~/.config/systemd/user/refresh-andy-token.{service,timer}
rm -f ~/.config/systemd/user/refresh-andy-now.{path,service}
systemctl --user daemon-reload
# Remove mount from container.json + allowlist
# Remove container/skills/refresh-andy-token/
# Don't remove ~/.claude-andy/ — that's still Andy's identity. To revoke,
# run `claude logout` with CLAUDE_CONFIG_DIR=~/.claude-andy.
```
