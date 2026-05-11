---
name: refresh-andy-token
description: Your own Claude Max OAuth token / login / API auth lifecycle. You MUST use this skill BEFORE answering any question about how long your token is valid, when it expires, your session length, refreshing your login, your auto-refresh schedule, or any related "do you have access to your own token info" question. Triggers: "Token", "login", "Sitzung", "Session", "Laufzeit", "wann läuft", "refresh", "erneuern", "API-Key abgelaufen". You DO have control via /workspace/extra/refresh-control/ — never improvise "I have no access".
---

# Refresh Andy's Token (Pure-Skill, Bash-Only)

**The operator's Claude Max account powers Andy.** When the access token expires
(~8h) or — more importantly — the refresh token (~1 week), Andy stops being
able to call `api.anthropic.com` and the operator sees `Invalid API key`
errors in the conversation. A host-side wrapper handles the OAuth flow
(post URL → wait for code → submit). Andy's job is to invoke it on demand.

You communicate with the host via the mounted control directory at
`/workspace/extra/refresh-control/`. Touching a flag file there triggers
a systemd path-unit on the host that runs the wrapper. Reading status is
just `cat status.json`.

## When to invoke

When the operator says any of these (German or English):

- "refresh dein/deinen Token", "Token erneuern", "neu einloggen", "fresh login"
- "wann läuft der Token ab", "wie lange noch", "Token-Status"
- "stop auto-refresh" / "pause auto-refresh" / "auto-refresh aus"
- "auto-refresh wieder an"

## How — the four bash one-liners

### 1. Trigger an immediate refresh

```bash
touch /workspace/extra/refresh-control/now
```

That is it. The host's path-unit (`refresh-andy-now.path` →
`refresh-andy-now.service`) sees the file appear, removes it, and runs
`refresh-andy-token.sh --now`. The wrapper posts a Discord embed with a
fresh OAuth URL to this channel; the operator clicks, authorizes, and
pastes the auth-code (looks like `code#state`) back into the channel.
The wrapper polls Discord for that message, pipes it into the waiting
claude TUI, and waits up to 10 minutes for `~/.claude-andy/.credentials.json`
to appear. Once it does, the OneCLI vault gets auto-synced via
`claude-oauth-sync.path`.

You don't post the URL — the **host wrapper does that**. Tell the operator:
"I've triggered a refresh — check the channel for the login URL."

### 2. Read the status

```bash
cat /workspace/extra/refresh-control/status.json
```

The host updates this file at every state transition (`running`, `success`,
`failed`, `idle`). Fields:

- `state` — last known state of the most recent run
- `detail` — short reason / phase
- `last_update` — ISO timestamp
- `timer_next_run` — next scheduled refresh, ISO
- `timer_state` — `active` (timer enabled) or `inactive`
- `current_token_expires_at` — when the **access** token expires (~8h scope)
- `current_token_hours_remaining` — float, helpful for humans

When the operator asks "wann läuft der Token ab?", report
`current_token_expires_at` and `current_token_hours_remaining` together
("läuft in 7.7 Stunden ab, also gegen 22:02 UTC heute"). When they ask
about the auto-refresh schedule, report `timer_next_run` and `timer_state`.

### 3. Pause the auto-refresh timer

The operator might ask to pause auto-refresh (e.g. they're traveling and
won't see Discord pings). The skill cannot disable systemd units from
inside the container. Tell the operator:

> "Ich kann den Auto-Refresh nicht selbst pausieren — auf dem Host:
> `systemctl --user disable --now refresh-andy-token.timer`. Reaktivieren:
> `systemctl --user enable --now refresh-andy-token.timer`. Manuelles
> Refresh-jetzt geht weiter über mich."

(This is a deliberate scope limit. Container has no host-systemd access,
and inventing a flag-file mechanism for enable/disable would be more
infrastructure than the user wants. Manual refresh-now is enough.)

### 4. (Diagnostic) See last refresh log

```bash
cat /workspace/extra/refresh-control/status.json | jq .detail
```

If the last `state` was `failed`, the `detail` field tells you what phase
failed (helper-URL-timeout, Discord-post-failed, code-wait-timeout,
credentials-timeout). Mention this to the operator so they can diagnose
on the host (`tail /tmp/refresh-andy-token.log`).

## Important guardrails

- **Never invent commands.** The four one-liners above are the entire
  toolkit. If the operator asks for something else (rotate refresh-token
  manually, decode the access-token, edit the OneCLI vault directly),
  decline and say it's outside this skill.
- **Don't post the URL yourself.** When you trigger via the `now` flag,
  the host wrapper posts the URL with a properly-rendered Discord embed.
  If you also post a URL via `send_message`, the operator gets duplicate
  messages.
- **Never read or echo `~/.claude-andy/.credentials.json`.** It's not
  mounted into your container, but if the operator pastes the file
  contents asking for help, treat it as sensitive — never echo it back.
- **Refresh is a 2-3 minute interactive flow.** After triggering, tell
  the operator something concrete is happening on Discord; don't just
  say "done."
