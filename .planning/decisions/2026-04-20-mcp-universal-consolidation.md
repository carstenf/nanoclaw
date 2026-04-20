# Decision: MCP Universal Consolidation (Bridge ↔ Core)

**Date:** 2026-04-20
**Status:** Decided — scheduled as Phase 4.5
**Context:** Phase 4 Wave 3 iOS StreamableHTTP debugging session surfaced
architectural drift from the original Voice-MCP design intent.

## What the spec says

Per ConOps, REQUIREMENTS.md (AC-07, AC-09, REQ-DIR-04, REQ-DIR-10, REQ-C6B-03)
and ARCHITECTURE-DECISION.md, the Bridge ↔ NanoClaw communication is specified
as **MCP in both directions**:

- **Bridge → NanoClaw** (Realtime tool-calls during a live voice call):
  Director Bridge acts as thin MCP-proxy to NanoClaw MCP-tools. Tool business
  logic stays entirely in NanoClaw.
- **NanoClaw/Andy → Bridge** (outbound call trigger): `voice.request_outbound_call`
  exposed as an MCP-tool on the Voice-MCP-Endpoint at 10.0.0.2:3201.

REST is permitted only for:
- Sipgate outbound (external boundary, REQ-SIP-02)
- Bridge `/outbound` internal HTTP trigger (REQ-INFRA-13)

Neither REST case touches the Bridge ↔ Core tool-dispatch path.

## What was actually built

### Phase 2 (2026-03): `voice-bridge/src/core-mcp-client.ts`

Despite the module name, the implementation is a JSON-POST REST facade:

```ts
const res = await fetch(`${baseUrl}/${name}`, {
  method: 'POST',
  body: JSON.stringify({ arguments: args }),
  ...
});
```

This is not MCP-spec compliant — no JSON-RPC 2.0 envelope, no `initialize`
handshake, no `capabilities` negotiation, no tool-list discovery. It's a
simpler per-tool HTTP endpoint served by `src/mcp-server.ts` on port 3200.

### Phase 4 Wave 3 (2026-04-19): `src/mcp-stream-server.ts`

AC-07 deliverable: a spec-compliant StreamableHTTP MCP server on port 3201,
sharing the same `ToolRegistry` as port 3200. Scoped as a **debug channel**
for Chat-Claude, not as a replacement for the production bridge → core path.

Result: two HTTP servers for the same tool surface on two protocols.

## The drift

| Aspect | Spec intent | Implementation |
|---|---|---|
| Bridge → Core protocol | MCP (JSON-RPC 2.0) | REST-style JSON-POST |
| Primary tool-dispatch port | 3201 (MCP) | 3200 (REST facade) |
| Number of protocols | 1 | 2 |
| Chat-Claude debug path | Same as production | Separate (port 3201) |

The drift likely originated in a Phase 2 shortcut — shipping the REST facade
was faster than implementing a full MCP client in the bridge. The module
name (`core-mcp-client.ts`) preserved the spec intent but the implementation
took the shortcut. Phase 4 Wave 3 then added the spec-compliant channel
alongside rather than replacing the REST path.

## Why it matters now

The 2026-04-19 iOS Claude-App debugging session consumed ~4 hours chasing
symptoms on port 3201. Every fix was correct per MCP spec (singleton
removal, per-request factory, URL simplification, listChanged:false, RFC
9728 discovery endpoints) and each one revealed the next layer. Ultimately
the iOS-UI-hang appears to be client-side behavior we cannot resolve
server-side.

That debugging effort was applied to the **debug channel**, not the
production path. If the spec had been fully implemented, Chat-Claude
iOS-hang would be a production-blocking bug demanding immediate attention.
Instead, it's noise on a path that real NanoClaw calls never touch.

## Decision

Schedule **Phase 4.5 — MCP Universal Consolidation** (separate from
Phase 4 which remains GOLD as gated).

Scope:

1. Migrate `voice-bridge/src/core-mcp-client.ts` from JSON-POST REST to
   `@modelcontextprotocol/sdk` StreamableHTTP client. Use a long-lived
   session (sessionIdGenerator enabled) to amortize the handshake across
   many tool calls per live voice-call.
2. Deprecate port 3200 REST server (`src/mcp-server.ts`). Optionally
   retain as read-only compatibility shim during a deprecation window.
3. Resolve iOS Claude-App compatibility — now a production blocker
   rather than a debug-channel nice-to-have. Likely requires session-
   based (not stateless) transport handling.
4. Update REQUIREMENTS.md wording on AC-07 so it no longer reads as
   "debug-only": the channel IS the production path.
5. Architecture doc update in `/opt/server-docs/hetzner-mcp-architecture.md`.

**Non-goals for Phase 4.5:**
- No changes to outbound call path (Sipgate REST stays, REQ-SIP-02).
- No changes to Bridge `/outbound` trigger surface (REQ-INFRA-13 REST stays).
- No expansion of the tool surface beyond what Phase 4 landed.

**Sequencing:** Phase 4.5 is gated on Phase 0 (legal) being green **only if**
iOS-Claude-App compatibility is required for production Case 6. If the
production plan accepts Claude Desktop + curl as sufficient admin tools,
Phase 4.5 can land before Phase 0.

## Alternative considered

Leave the drift in place, continue treating port 3201 as debug-only. Pro:
zero code churn, production works. Con: dual protocol maintenance, two
audit surfaces, iOS hangs unresolved forever, spec-docs stay misleading.

Rejected because the spec clearly intends single-protocol and the dual
maintenance burden compounds with every tool added.

## References

- Chat drift analysis: `~/nanoclaw-state/briefing.md` 2026-04-20 "Architecture anchor"
- REQUIREMENTS.md: AC-07, AC-09, REQ-DIR-04, REQ-DIR-10, REQ-C6B-03
- ConOps: `~/nanoclaw-state/voice-channel-spec/CONOPS.md`
- ARCHITECTURE-DECISION.md
- Phase 4 Wave 3 plan: `.planning/phases/04-core-tool-integration-cost-observability/04-03-PLAN.md`
- Session evidence: 2026-04-19 22:00-02:00 iOS debugging, commits
  `9068fd8`, `3a70f08`, `0a5ba27`, Chat `d5ec09f`
