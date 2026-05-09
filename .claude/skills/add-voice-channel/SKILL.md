---
name: add-voice-channel
description: Add voice-channel client integration to NanoClaw — connects this NanoClaw to a voice-stack (FreeSWITCH + OpenAI Realtime SIP) running on the same host or via WireGuard. Voice-stack must already be deployed (see github.com/carstenf/mcp-voice-channel). Topology-agnostic — single-host or split-host.
---

# Add Voice Channel (Pattern-B)

This skill adds voice-channel client integration to NanoClaw. Pattern-B
architecture: voice-mcp on the voice-stack side is a pure MCP server,
NanoClaw is its MCP client (long-poll for ask_core questions). Mirror of
the hindsight-mcp integration shape.

The voice infrastructure (FreeSWITCH, OpenAI Realtime SIP bridge, voice-mcp
orchestrator, webhook forwarder) lives in
[`carstenf/mcp-voice-channel`](https://github.com/carstenf/mcp-voice-channel)
and must already be deployed (branch `pattern-b` or later) before this
skill runs.

## Phase 1: Pre-flight

### Check if already applied

If `src/voice-mcp-client.ts` exists in the trunk, the skill is already
applied; skip to Phase 4 (Configure).

### Verify voice-stack is reachable

Use `AskUserQuestion`:

- **Is a `mcp-voice-channel` voice-stack already deployed and reachable?**
  - "Yes, on this same host" → URL = `http://localhost:3150/`
  - "Yes, on a remote host via WireGuard" → ask for the WG peer (commonly
    `10.0.0.1`); URL = `http://10.0.0.1:3150/`
  - "No, not yet deployed" → STOP. Point user to
    `carstenf/mcp-voice-channel` `README.md` and abort the skill.

### Collect configuration

- **VOICE_MCP_URL** — voice-stack `/` MCP endpoint (Andy's outbound MCP
  block + this client both target this).
- **VOICE_MCP_BEARER** — the bearer voice-stack expects. User has it in
  `voice-stack/.env` as `VOICE_MCP_BEARER`.
- **DISCORD_BOT_TOKEN** (voice-stack side) — copy from this nanoclaw `.env`
  to voice-stack `.env` so voice-mcp can post transcripts via the Discord
  bot API.
- **Operator name + caller-ID** — for `~/.config/nanoclaw/voice-config.json`
  on voice-mcp's side (not nanoclaw's — Pattern-B owns voice-config there).

## Phase 2: Apply trunk-side files

```bash
git remote add voice https://github.com/carstenf/nanoclaw-voice-channel.git
git fetch voice pattern-b
git merge voice/pattern-b --allow-unrelated-histories --no-edit
```

If the merge reports conflicts on `README.md`, prefer the trunk:

```bash
git checkout --ours README.md && git add README.md && git commit --no-edit
```

Confirm the three files landed:

- `src/voice-mcp-client.ts` — long-poll loop + IPC-inject + cold-spawn fallback
- `src/voice-respond-manager.ts` — call_id ↔ Promise correlation
- `container/agent-runner/src/voice-request.ts` — IPC envelope drain helpers

## Phase 3: Apply trunk patches

The Pattern-B integration has 4 small patches to existing trunk files.
Use `Edit` for each.

### `container/agent-runner/src/index.ts`

After the `import { fileURLToPath } from 'url';` line, add:

```ts
import {
  isVoiceRequestEnvelope,
  consumeVoiceRequest,
  takePendingVoiceRequest,
} from './voice-request.js';
```

Add a third variant to the `ContainerOutput` discriminated union (after
`ContainerError`):

```ts
interface ContainerVoiceResponse extends ContainerOutputBase {
  status: 'voice_response';
  result: string | null;
  call_id: string;
  discord_long?: string | null;
}

type ContainerOutput =
  | ContainerSuccess
  | ContainerError
  | ContainerVoiceResponse;
```

In `drainIpcInput`, add a branch alongside the `data.type === 'message'`
case:

```ts
} else if (isVoiceRequestEnvelope(data)) {
  messages.push(consumeVoiceRequest(data));
}
```

In the `if (message.type === 'result')` block (the result-emit path), wrap
the existing `writeOutput({ status: 'success', ... })` so a pending voice
call_id triggers a `voice_response` marker:

```ts
const voiceCallId = takePendingVoiceRequest();
if (voiceCallId) {
  writeOutput({
    status: 'voice_response',
    result: textResult || null,
    call_id: voiceCallId,
    discord_long: null,
    newSessionId,
  });
} else {
  writeOutput({
    status: 'success',
    result: textResult || null,
    newSessionId,
  });
}
```

### `src/container-runner.ts`

Mirror the host-side type to match the agent-runner's:

```ts
export interface ContainerVoiceResponse extends ContainerOutputBase {
  status: 'voice_response';
  result: string | null;
  call_id: string;
  discord_long?: string | null;
}

export type ContainerOutput =
  | ContainerSuccess
  | ContainerError
  | ContainerVoiceResponse;
```

### `src/group-queue.ts`

Add a `sendVoiceRequest` method to the `GroupQueue` class, alongside
`sendMessage`:

```ts
sendVoiceRequest(
  groupJid: string,
  callId: string,
  prompt: string,
): boolean {
  const safeId = callId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  return this.sendIpcEnvelope(
    groupJid,
    { type: 'voice_request', call_id: callId, prompt },
    `voice-${safeId}`,
  );
}
```

### `src/index.ts`

Add imports near the top:

```ts
import { startVoiceMcpClient } from './voice-mcp-client.js';
import { getVoiceRespondManager } from './voice-respond-manager.js';
```

In the `runAgent`'s `onOutput` callback, add a branch BEFORE the existing
`if (result.result)` block:

```ts
if (result.status === 'voice_response') {
  const raw = typeof result.result === 'string' ? result.result : '';
  const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  getVoiceRespondManager().resolve(result.call_id, {
    voice_short: text,
    discord_long: result.discord_long ?? null,
  });
  outputSentToUser = true;
  resetIdleTimer();
  queue.notifyIdle(chatJid);
  return;
}
```

After `startMcpServer({...})` and before `queue.setProcessMessagesFn(...)`,
add:

```ts
startVoiceMcpClient({
  queue,
  getMainGroupAndJid,
  getRegisteredGroups: () => registeredGroups,
  assistantName: ASSISTANT_NAME,
});
```

## Phase 4: Configure environment

Add to NanoClaw's `.env`:

```
VOICE_MCP_URL=<the URL from Phase 1, e.g. http://10.0.0.1:3150/>
VOICE_MCP_BEARER=<the voice-stack bearer>
```

Sync to the container env if you mount `data/env/env`:

```bash
mkdir -p data/env && cp .env data/env/env
```

On the voice-stack side, ensure `DISCORD_BOT_TOKEN` is present (copy from
this nanoclaw's `.env`):

```
# voice-stack/.env
DISCORD_BOT_TOKEN=<same value as nanoclaw's DISCORD_BOT_TOKEN>
```

Then restart both:

```bash
# nanoclaw (Linux)
systemctl --user restart nanoclaw
# nanoclaw (macOS)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# voice-stack
cd ~/voice-stack && docker compose restart voice-mcp
```

## Phase 5: Smoke-test

From the voice-stack host, dispatch a synthetic init trigger:

```bash
BEARER=$(grep -oP 'VOICE_MCP_BEARER=\K.*' ~/voice-stack/.env)
curl -sS -X POST http://localhost:3150/ \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json,text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"voice_triggers_init","arguments":{"call_id":"smoke-1","case_type":"case_6b","call_direction":"inbound","counterpart_label":"smoke","lang":"de"}}}' \
  | head -c 200
```

Expect `{"ok":true,"result":{"instructions":"### ROLE & OBJECTIVE..."}}`.

Confirm NanoClaw's MCP client connected:

```bash
journalctl --user -u nanoclaw --since "1 minute ago" | grep voice_mcp_client_connected
```

Expect a `voice_mcp_client_connected` log line.

## Architecture summary

```
voice-bridge ←→ voice-mcp (voice-stack host)
                  │
                  │  MCP server (StreamableHTTP, port 3150)
                  ▼
                NanoClaw (long-poll MCP client)
                  │
                  │  IPC envelope into live main container
                  ▼
                Andy → voice_response marker → voice_post_answer
```

Voice-mcp owns: persona render, Discord posting (via bot API), retry queue,
call lifecycle. NanoClaw only owns: ask_core inversion (voice → Andy).
Mirror of how hindsight-mcp owns memory storage + recall.

## Tear down

```bash
# Remove env vars
sed -i '/^VOICE_MCP_URL=/d; /^VOICE_MCP_BEARER=/d' .env

# Revert trunk patches (manual: undo the 4 edits in Phase 3)
# Delete the 3 added files:
rm -f src/voice-mcp-client.ts src/voice-respond-manager.ts \
      container/agent-runner/src/voice-request.ts

# Restart
systemctl --user restart nanoclaw
```

The voice-stack can stay up untouched.
