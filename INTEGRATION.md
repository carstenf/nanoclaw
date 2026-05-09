# Integration

The v2-friendly voice-channel skill ships **two trunk-side files** plus a
handler-wiring helper. Voice-mcp (the Hetzner stack) is the single
integration point for everything else; trunk only exposes one inbound
HTTP surface (`POST /voice/dispatch`).

## Files dropped into the trunk

- `src/channels/voice.ts` — channel adapter (HTTP server on
  `VOICE_DISPATCH_PORT`, bearer-protected, plug-in handler map).
  Self-registers as the `voice` channel via `registerChannel()`.
- `src/voice-channel-config.ts` — env reader (`VOICE_MCP_URL`,
  `VOICE_MCP_BEARER`, `VOICE_DISPATCH_BEARER`, optional `_PORT` / `_BIND`).
- `src/voice-channel-handlers.ts` — `setupVoiceHandlers(channel, deps)`
  wires the per-tool handlers. Deterministic tools (init / transcript /
  on_transcript_turn / set_language) run inline through
  `src/voice-render.ts`. `voice_ask_core` and `voice_send_discord_message`
  route through host-supplied dependency callbacks.
- `src/voice-render.ts` — pure-template persona renderer (the
  deterministic Option-E port from v1's `voice-agent-invoker.ts`).
- `src/voice-config.ts` — `voice-config.json` reader (operator name,
  CLI number). Voice-mcp's `voice_set_operator_config` tool is the
  canonical writer.

Plus skill data (no code): `container/skills/voice-personas/baseline.md`
and the case-overlay markdown. These the renderer reads at request time.

## Single integration line

After channels are registered and the host's `spawnVoiceAgent` /
`sendDiscordMessage` are available, call:

```ts
import { setupVoiceHandlers } from './voice-channel-handlers.js';
import { getVoiceChannel } from './channels/voice.js';

const vc = getVoiceChannel();
if (vc) {
  setupVoiceHandlers(vc, {
    spawnVoiceAgent: async ({ callId, prompt, timeoutMs }) => {
      // call into the host's container-runner, return Andy's structured reply
    },
    sendDiscordMessage: async ({ channel, content }) => {
      // call into the host's already-connected Discord client
    },
  });
}
```

That single line replaces the six v1 patches across `src/index.ts`,
`src/db.ts`, `src/group-queue.ts`, `src/config.ts`,
`src/mcp-tools/index.ts`, `container/agent-runner/src/index.ts`.

## Environment variables

Required in the trunk's `.env`:

| Var | Purpose |
| --- | --- |
| `VOICE_MCP_URL` | voice-mcp `/mcp` endpoint Andy talks to (`https://mcp…/voice/mcp`) |
| `VOICE_MCP_BEARER` | bearer for `/mcp` |
| `VOICE_DISPATCH_BEARER` | bearer that voice-mcp must present on `POST /voice/dispatch` |

Optional:

| Var | Default |
| --- | --- |
| `VOICE_DISPATCH_PORT` | `3202` |
| `VOICE_DISPATCH_BIND` | `0.0.0.0` (use the WG IP on multi-host deploys) |
| `OPERATOR_NAME` | resolved from `voice-config.json`, then env, then a lang-neutral fallback |
| `ASSISTANT_NAME` | `Andy` |

## Wire protocol

```
POST ${VOICE_DISPATCH_BIND}:${VOICE_DISPATCH_PORT}/voice/dispatch
Authorization: Bearer ${VOICE_DISPATCH_BEARER}
Content-Type:  application/json
Body:          { "tool": "<name>", "args": { … } }

200 OK         { "ok": true,  "result": <tool-specific> }
               { "ok": false, "error": "<string>" }
```

Mirror of `mcp-voice-channel/voice-mcp/src/orchestrator/dispatcher.ts`.
