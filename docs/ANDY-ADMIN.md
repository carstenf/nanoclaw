# Andy Admin Reference

Moved out of `groups/main/CLAUDE.md` to keep Andy's runtime system prompt
lean (open_points 2026-04-27 — Discord-Latenz). When Andy needs to register/
remove/list groups or design scheduled task scripts, he should read this file
on demand (it's reachable from inside the container at
`/workspace/project/docs/ANDY-ADMIN.md`).

For Claude Code working on the repo, this is the operational reference for
the same topics.

---

## Admin Context

The main channel (Discord) has elevated privileges. Discord Markdown
formatting; can delete messages.

## Authentication

Anthropic credentials must be either an API key from console.anthropic.com
(`ANTHROPIC_API_KEY`) or a long-lived OAuth token from `claude setup-token`
(`CLAUDE_CODE_OAUTH_TOKEN`). Short-lived tokens from the system keychain or
`~/.claude/.credentials.json` expire within hours and can cause recurring
container 401s. The `/setup` skill walks through this. OneCLI manages
credentials (including Anthropic auth) — run `onecli --help`.

## Container Mounts (main group)

Read-only project, read-write store + group folder.

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| `/workspace/project` | Project root | read-only |
| `/workspace/project/store` | `store/` | read-write |
| `/workspace/group` | `groups/main/` | read-write |

Key paths inside the container:
- `/workspace/project/store/messages.db` — SQLite database (read-write)
- `/workspace/project/store/messages.db` (`registered_groups` table) — group config
- `/workspace/project/groups/` — all group folders

---

## Managing Groups

### Finding Available Groups

Available groups are provided in `/workspace/ipc/available_groups.json`:

```json
{
  "groups": [
    {
      "jid": "120363336345536173@g.us",
      "name": "Family Chat",
      "lastActivity": "2026-01-31T12:00:00.000Z",
      "isRegistered": false
    }
  ],
  "lastSync": "2026-01-31T12:00:00.000Z"
}
```

Groups are ordered by most recent activity. The list is synced from WhatsApp
daily.

If a group the user mentions isn't in the list, request a fresh sync:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

Then wait a moment and re-read `available_groups.json`.

**Fallback**: query the SQLite database directly:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, last_message_time
  FROM chats
  WHERE jid LIKE '%@g.us' AND jid != '__group_sync__'
  ORDER BY last_message_time DESC
  LIMIT 10;
"
```

### Registered Groups Config

Groups are registered in the SQLite `registered_groups` table:

```json
{
  "1234567890-1234567890@g.us": {
    "name": "Family Chat",
    "folder": "whatsapp_family-chat",
    "trigger": "@Andy",
    "added_at": "2024-01-31T12:00:00.000Z"
  }
}
```

Fields:
- **Key**: chat JID (unique identifier — WhatsApp, Telegram, Slack, Discord, …)
- **name**: display name
- **folder**: channel-prefixed folder under `groups/` for this group's files + memory
- **trigger**: trigger word (usually same as global, but can differ)
- **requiresTrigger**: default `true`. `false` for solo/personal chats where every message processes
- **isMain**: main control group (elevated privileges, no trigger needed)
- **added_at**: ISO timestamp when registered

### Trigger Behavior

- **Main group** (`isMain: true`): no trigger — every message processed
- **`requiresTrigger: false`**: no trigger — every message processed (solo/1-on-1)
- **Other groups** (default): messages must start with `@AssistantName` to be processed

### Adding a Group

1. Query the database for the group JID
2. Ask the user whether the group should require a trigger word
3. Use the `register_group` MCP tool with the JID, name, folder, trigger, and chosen `requiresTrigger`
4. Optionally include `containerConfig` for additional mounts
5. The group folder is created automatically: `/workspace/project/groups/{folder-name}/`
6. Optionally create an initial `CLAUDE.md` for the group

Folder naming convention — channel prefix + underscore separator:
- WhatsApp "Family Chat" → `whatsapp_family-chat`
- Telegram "Dev Team" → `telegram_dev-team`
- Discord "General" → `discord_general`
- Slack "Engineering" → `slack_engineering`
- Lowercase, hyphens for the group name part

#### Adding Additional Directories for a Group

Add `containerConfig` to the group's entry:

```json
{
  "1234567890@g.us": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "~/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ]
    }
  }
}
```

The directory appears at `/workspace/extra/webapp` in that group's container.

#### Sender Allowlist

After registering a group, explain the sender allowlist feature:

> This group can be configured with a sender allowlist:
>
> - **Trigger mode** (default): everyone's messages are stored for context, only allowed senders can trigger me with @{AssistantName}.
> - **Drop mode**: messages from non-allowed senders are not stored at all.
>
> For closed groups with trusted members, an allow-only list is recommended.

To set up: edit `~/.config/nanoclaw/sender-allowlist.json` on the host:

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "<chat-jid>": {
      "allow": ["sender-id-1", "sender-id-2"],
      "mode": "trigger"
    }
  },
  "logDenied": true
}
```

Notes:
- Own messages (`is_from_me`) bypass the allowlist in trigger checks. Bot messages are filtered before trigger evaluation, so they never reach the allowlist.
- Missing/invalid config = fail-open (all senders allowed)
- The config file lives on the host, not inside the container

### Removing a Group

1. Read `/workspace/project/data/registered_groups.json`
2. Remove the entry
3. Write the updated JSON back
4. The group folder and its files stay (don't delete them)

### Listing Groups

Read `/workspace/project/data/registered_groups.json` and format nicely.

---

## Task Scripts (scheduled-task design)

For recurring tasks, use `schedule_task`. Frequent agent invocations —
especially multiple times a day — consume API credits and can risk account
restrictions. If a simple check can determine whether action is needed, add a
`script` — it runs first, and the agent is only invoked when the check
passes. Keeps invocations to a minimum.

### How it works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first (30-second timeout)
3. Script prints JSON to stdout: `{ "wakeAgent": true/false, "data": {...} }`
4. `wakeAgent: false` → nothing happens, task waits for next run
5. `wakeAgent: true` → agent wakes up with the script's data + prompt

### Always test your script first

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

For tasks that require judgment every time (daily briefings, reminders,
reports) — just use a regular prompt without a script.

### Frequent task guidance

If a user wants tasks running > ~2x daily and a script can't reduce agent
wake-ups:

- Explain that each wake-up uses API credits and risks rate limits
- Suggest restructuring with a script that checks the condition first
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help find the minimum viable frequency
