---
name: add-hindsight
description: Wire NanoClaw v2 agents to a separately-running universal hindsight-mcp instance. Per-agent stdio MCP server that proxies to Hindsight's HTTP engine over WireGuard. Adds memory_retain / memory_recall / memory_reflect tools.
---

# Add Hindsight Memory

Connects NanoClaw v2 agents to an **already-running** universal `hindsight-mcp`
stack (Hindsight engine + stdio binary, owned by the `hindsight-mcp` user on
the same host). Each agent group gets its own bank under
`<HINDSIGHT_BANK_PREFIX>:<groupfolder>`.

This skill assumes the universal hindsight-mcp is **already deployed**. If it
isn't, that's out of scope here — talk to the operator who owns
`/home/hindsight-mcp/app/`. The contract this skill expects:

- A built stdio binary at `<host-path>/dist/server-stdio.js`
- Hindsight engine reachable from the host (default: `http://10.0.0.2:3850`)
- ACLs that let nanoclaw's container uid (1001 = node) read the binary path

## Phase 1: Pre-flight

### 1.1 Verify hindsight-mcp reachability and binary

Replace `<HINDSIGHT_BIN_PATH>` and `<HINDSIGHT_ENGINE_URL>` with your operator's values:

```bash
HINDSIGHT_BIN_PATH=/home/hindsight-mcp/app
HINDSIGHT_ENGINE_URL=http://10.0.0.2:3850

# Engine reachable?
curl -fsS "$HINDSIGHT_ENGINE_URL/health"
# Expected: {"status":"ok",...}

# Binary visible to nanoclaw user?
ls -la "$HINDSIGHT_BIN_PATH/dist/server-stdio.js"
# Must be readable. ACL form (`+` after permissions) is fine.

# Binary works as nanoclaw user?
HINDSIGHT_URL="$HINDSIGHT_ENGINE_URL" HINDSIGHT_BANK_PREFIX=test \
  bash -c '(printf "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"s\",\"version\":\"0.1\"}}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n"; sleep 3) | timeout 5 node '"$HINDSIGHT_BIN_PATH"'/dist/server-stdio.js 2>&1 | head -5'
# Expected: "[hindsight-mcp/stdio] connected" + initialize result + tools/list with 3 tools.
```

Stop if any step fails. Common issues:

- Engine 404 / connection refused → engine not bound on the URL you think.
  Universal hindsight-mcp publishes the engine port separately from the
  HTTP wrapper. Operator needs to expose it.
- ACL denied → operator must `setfacl -R -m u:1001:rX <HINDSIGHT_BIN_PATH>`
  and grant traverse on parent dir.
- Stdio binary not found → wrong path, or operator didn't run `npm run build`.

### 1.2 Add the binary path to the mount allowlist

The host enforces an allowlist for `additionalMounts`. Edit
`~/.config/nanoclaw/mount-allowlist.json` to include an entry for the
binary path:

```jsonc
{
  "allowedRoots": [
    {
      "path": "/home/hindsight-mcp/app",
      "allowReadWrite": false,
      "description": "Universal hindsight-mcp stdio binary + node_modules (read-only)"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

The host caches the allowlist in-process. After the edit, restart the
host service so it reloads:

```bash
systemctl --user restart nanoclaw-v2-*.service   # Linux
# or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Phase 2: Per-agent-group wiring

For each agent group that should have memory, edit `groups/<folder>/container.json`.

**`mcpServers.hindsight` block:**

```jsonc
{
  "command": "node",
  "args": ["/workspace/extra/hindsight-mcp/dist/server-stdio.js"],
  "env": {
    "HINDSIGHT_URL": "http://10.0.0.2:3850",
    "HINDSIGHT_BANK_PREFIX": "nanoclaw"
  },
  "instructions": "You have a long-term memory tool `hindsight` (memory_retain, memory_recall, memory_reflect). Use `group=\"<folder>\"` for this agent's bank. Retain durable facts the user shares; recall before answering when prior context might exist. Heavy synthesis: reflect."
}
```

Replace `<folder>` in the `instructions` field with the actual group folder
name — that's how the agent learns which bank to address.

**`additionalMounts` entry:**

```jsonc
{
  "hostPath": "/home/hindsight-mcp/app",
  "containerPath": "hindsight-mcp",
  "readonly": true
}
```

The `containerPath` must be relative — the host prefixes it with
`/workspace/extra/`, which is why `args` above points at
`/workspace/extra/hindsight-mcp/dist/server-stdio.js`.

After editing, stop any running container for that group so the next
inbound message respawns with the new mounts and config:

```bash
docker ps --filter "name=nanoclaw-v2-<folder>" --format '{{.Names}}' \
  | xargs -r docker stop
```

## Phase 3: Default for new agent groups (optional, recommended)

To make every newly-created agent group come pre-wired with hindsight,
patch `src/group-init.ts` to call a helper after `initContainerConfig`.

In `src/group-init.ts`, find:

```typescript
import { initContainerConfig } from './container-config.js';
```

Add the import for the helper:

```typescript
import { ensureHindsightWired } from './group-init-hindsight.js';
```

Then in the function body, find:

```typescript
  if (initContainerConfig(group.folder)) {
    initialized.push('container.json');
  }
```

Replace with:

```typescript
  if (initContainerConfig(group.folder)) {
    initialized.push('container.json');
  }
  if (ensureHindsightWired(group.folder)) {
    initialized.push('container.json [+hindsight]');
  }
```

Create `src/group-init-hindsight.ts`:

```typescript
import { readContainerConfig, writeContainerConfig } from './container-config.js';

const HINDSIGHT_HOST_PATH = '/home/hindsight-mcp/app';
const HINDSIGHT_CONTAINER_PATH = 'hindsight-mcp';
const HINDSIGHT_ENGINE_URL = 'http://10.0.0.2:3850';
const HINDSIGHT_BANK_PREFIX = 'nanoclaw';

export function ensureHindsightWired(folder: string): boolean {
  const config = readContainerConfig(folder);

  if (config.mcpServers.hindsight) return false;

  config.mcpServers.hindsight = {
    command: 'node',
    args: [`/workspace/extra/${HINDSIGHT_CONTAINER_PATH}/dist/server-stdio.js`],
    env: {
      HINDSIGHT_URL: HINDSIGHT_ENGINE_URL,
      HINDSIGHT_BANK_PREFIX: HINDSIGHT_BANK_PREFIX,
    },
    instructions: `You have a long-term memory tool \`hindsight\` (memory_retain, memory_recall, memory_reflect). Use \`group="${folder}"\` for this agent's bank. Retain durable facts the user shares; recall before answering when prior context might exist. Heavy synthesis: reflect.`,
  };

  if (!config.additionalMounts.some((m) => m.hostPath === HINDSIGHT_HOST_PATH)) {
    config.additionalMounts.push({
      hostPath: HINDSIGHT_HOST_PATH,
      containerPath: HINDSIGHT_CONTAINER_PATH,
      readonly: true,
    });
  }

  writeContainerConfig(folder, config);
  return true;
}
```

Then `pnpm run build`. The change is idempotent — running group-init on
an already-wired group is a no-op.

## Phase 4: Smoke-test

Send a message to a wired agent that explicitly requires the tool, e.g.
on Discord/Telegram/CLI:

> Test memory: please call memory_retain explicitly with content="MARKER-XXXX is the test marker" and group="<your-folder>". Reply only after the tool succeeds.

Then verify the bank from the host (using the http wrapper's
read-back endpoint, with the bearer token your operator has stored —
typically in OneCLI vault under host pattern matching the http endpoint):

```bash
TOK=<bearer-from-vault>
SID=$(curl -s -i -X POST http://10.0.0.2:3852/mcp \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer $TOK" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"v","version":"0.1"}}}' \
  | awk '/mcp-session-id:/ {print $2}' | tr -d '\r')
curl -s -X POST http://10.0.0.2:3852/mcp \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer $TOK" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' >/dev/null
curl -s -X POST http://10.0.0.2:3852/mcp \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer $TOK" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_recall","arguments":{"group":"<your-folder>","query":"MARKER"}}}'
```

Expected: at least one result row with the marker in `text`. Hindsight
will also extract entities and build graph edges automatically.

## Pitfalls

- **Resumed SDK sessions hallucinate "stored"**. If the agent had prior
  conversation context where it claimed to retain something (back when
  the tool wasn't actually wired), the SDK session resume carries that
  context and the agent will keep saying "already stored" without
  calling the tool. Use a clearly-novel test marker phrase to force a
  fresh tool call.

- **Container caches config at spawn**. Editing `container.json` for a
  running container has no effect. Stop the container; next inbound
  spawns fresh.

- **Mount-allowlist is in-process cached**. After editing
  `~/.config/nanoclaw/mount-allowlist.json`, restart the host service.

- **`containerPath` must be relative**. The host prefixes everything
  with `/workspace/extra/`. Absolute paths are silently rejected by
  `validateMount`.

- **Bank prefix is set at the binary level via env**. The HTTP wrapper's
  bearer token determines prefix server-side; the stdio binary bypasses
  that and uses `HINDSIGHT_BANK_PREFIX` instead. Pick one prefix per
  install (typically `nanoclaw`) and use it consistently across all
  agent groups, or you'll fragment memory across banks.

- **Mnemon is a competing memory provider**. If `/add-mnemon` was run
  previously, both will fire their own retain/recall flows and confuse
  the agent. Pick one.
