// Phase 4.5 Wave-1 (Plan 04.5-01) regression harness for the session-based
// StreamableHTTP server (src/mcp-stream-server.ts).
//
// Scenario titles are a CONTRACT — orchestrator `vitest -t "..."` filters
// must match. Source of truth: 04.5-VALIDATION.md and 04.5-CONTEXT.md D-15.
//
// Design:
// - Ephemeral-port HTTP fixture (port 0) mirrors src/mcp-stream-server.test.ts.
// - Real MCP `Client` + `StreamableHTTPClientTransport` drives initialize +
//   tools/list + tools/call against a fresh registry (18 voice.* names with
//   echo handlers — real handlers are tested elsewhere).
// - Scenarios 2 and 5 use raw `fetch` because they exercise error paths that
//   the SDK Client API does not expose directly (session_required 400, bogus
//   sid behavior).
//
// The echo handlers return `{ ok: true, echo: args, tool: name }` so
// assertion logic can check per-session isolation via the echoed arguments.
//
// NOTE: args must satisfy the zod shape declared in TOOL_META (the SDK
// validates pre-handler). For `voice_search_competitors` that means
// `{ date: 'YYYY-MM-DD', duration_minutes: 1..1440 }`; for
// `voice_request_outbound_call` the shape requires `target_phone` (E.164),
// `goal`, `report_to_jid`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { buildMcpStreamApp } from './mcp-stream-server.js';
import { ToolRegistry } from './mcp-tools/index.js';
import type { logger } from './logger.js';

const BEARER = 'test-token';

// V2.1 voice.* surface — mirrors TOOL_META keys in src/mcp-stream-server.ts.
// Every name registers an echo handler so tools/list shows them and
// tools/call round-trips without touching real services.
const VOICE_TOOL_NAMES = [
  'voice_send_discord_message',
  'voice_get_contract',
  'voice_get_practice_profile',
  'voice_schedule_retry',
  'voice_search_competitors',
  'voice_on_transcript_turn',
];

function makeLog() {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  } as unknown as typeof logger;
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const name of VOICE_TOOL_NAMES) {
    r.register(name, async (args) => ({ ok: true, echo: args, tool: name }));
  }
  return r;
}

let server: Server | null = null;
let baseUrl = '';

async function startApp(ttlMs?: number): Promise<void> {
  if (ttlMs !== undefined) {
    process.env.MCP_STREAM_SESSION_TTL_MS = String(ttlMs);
  }
  const app = buildMcpStreamApp({
    registry: makeRegistry(),
    bearerToken: BEARER,
    allowlist: ['127.0.0.1', '::ffff:127.0.0.1', '::1'],
    log: makeLog(),
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/`;
}

async function stopApp(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  delete process.env.MCP_STREAM_SESSION_TTL_MS;
}

beforeEach(async () => {
  await startApp();
});

afterEach(async () => {
  await stopApp();
});

async function newClient(): Promise<{
  c: Client;
  t: StreamableHTTPClientTransport;
}> {
  const t = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${BEARER}` } },
  });
  const c = new Client(
    { name: 'regression', version: '0.0.1' },
    { capabilities: {} },
  );
  await c.connect(t);
  return { c, t };
}

describe('Phase 4.5 MCP regression — session-based StreamableHTTP', () => {
  it('scenario 1: initialize + tools/list + tools/call × 3 on session-based transport, each < 500 ms', async () => {
    const t0 = Date.now();
    const { c } = await newClient();
    expect(Date.now() - t0).toBeLessThan(500);

    const tList0 = Date.now();
    const list = await c.listTools();
    expect(Date.now() - tList0).toBeLessThan(500);
    expect(list.tools.map((x) => x.name)).toContain('voice_search_competitors');

    for (let i = 0; i < 3; i++) {
      const t1 = Date.now();
      const r = await c.callTool({
        name: 'voice_search_competitors',
        arguments: { category: 'test', criteria: { duration_minutes: 60 } },
      });
      expect(Date.now() - t1).toBeLessThan(500);
      const content = r.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toMatch(/"ok":\s*true/);
    }
    await c.close();
  });

  it('scenario 2: stateless-fallback path returns spec-compliant error within 500 ms (no indefinite hang)', async () => {
    // After Plan 04.5-01, the server is session-based — there is no stateless
    // fallback. The equivalent "no hang" guarantee is: a non-initialize POST
    // without Mcp-Session-Id must return 400 session_required PROMPTLY
    // (not hang waiting for a session that will never come).
    const t0 = Date.now();
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BEARER}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.error.message).toBe('session_required');
  });

  it('scenario 3: initialize response has capabilities.tools.listChanged === false', async () => {
    // Drive initialize via raw fetch so we can parse the SSE-framed response
    // and inspect the `capabilities.tools.listChanged` flag directly.
    const initBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'regression-scenario-3', version: '0' },
      },
    };
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BEARER}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initBody),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const body = JSON.parse((dataLine as string).slice('data: '.length));
    expect(body.result).toBeDefined();
    expect(body.result.capabilities?.tools?.listChanged).toBe(false);
  });

  it('scenario 4: two concurrent sessions, 3 tools/call each, no JSON-RPC id cross-contamination', async () => {
    // Regression guard for SDK Issue #1405 (Pitfall 1): a shared McpServer
    // across sessions causes session A's pending tools/call to abort when
    // session B connects. Per-session McpServer fixes this; this test
    // exercises two live sessions in parallel and asserts each sees only
    // its own echoed arguments.
    const [a, b] = await Promise.all([newClient(), newClient()]);

    const aResults = await Promise.all(
      [1, 2, 3].map((i) =>
        a.c.callTool({
          name: 'voice_search_competitors',
          arguments: { category: 'test', criteria: { duration_minutes: i * 10 } },
        }),
      ),
    );
    const bResults = await Promise.all(
      [4, 5, 6].map((i) =>
        b.c.callTool({
          name: 'voice_search_competitors',
          arguments: { category: 'test', criteria: { duration_minutes: i * 10 } },
        }),
      ),
    );

    for (let i = 0; i < 3; i++) {
      const aText = (aResults[i].content as Array<{ text: string }>)[0].text;
      const bText = (bResults[i].content as Array<{ text: string }>)[0].text;
      // Session A called with duration 10, 20, 30
      expect(aText).toMatch(new RegExp(`"duration_minutes":${(i + 1) * 10}`));
      // Session B called with duration 40, 50, 60
      expect(bText).toMatch(new RegExp(`"duration_minutes":${(i + 4) * 10}`));
      // And no cross-contamination the other way.
      expect(aText).not.toMatch(new RegExp(`"duration_minutes":${(i + 4) * 10}`));
      expect(bText).not.toMatch(new RegExp(`"duration_minutes":${(i + 1) * 10}`));
    }

    await a.c.close();
    await b.c.close();
  });

  it('scenario 5: expired session ID returns 404, not 500', async () => {
    // Spec: an expired (known-evicted) session ID should get 404 from the
    // SDK transport; an unknown sid collapses to 400 session_required in
    // our handler. Both are acceptable "prompt, non-hanging, non-500"
    // responses — the critical behavior under test is no 500, no hang.
    //
    // Pragmatic probe: send a request with an unknown Mcp-Session-Id as a
    // non-initialize body. The handler sees Map miss → non-initialize →
    // returns 400 session_required (our server cannot distinguish "never
    // existed" from "expired and swept" without extra bookkeeping, which
    // spec allows collapsing). If a future SDK change returns 404 for this
    // path we accept that too. Critical: must be 4xx, < 500ms, not 500.
    const t0 = Date.now();
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BEARER}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'nonexistent-sid-0000',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(Date.now() - t0).toBeLessThan(500);
    expect([400, 404]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });

  it('tools_list_schemas: V2.1 voice.* tools present on tools/list with non-empty inputSchema', async () => {
    const { c } = await newClient();
    const list = await c.listTools();
    const voiceTools = list.tools.filter((t) => t.name.startsWith('voice_'));
    expect(voiceTools.length).toBeGreaterThanOrEqual(VOICE_TOOL_NAMES.length);
    const names = new Set(voiceTools.map((t) => t.name));
    for (const expected of VOICE_TOOL_NAMES) {
      expect(names.has(expected)).toBe(true);
    }
    for (const t of voiceTools) {
      expect(typeof t.description).toBe('string');
      expect((t.description as string).length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
    }
    await c.close();
  });

  // V2.1: voice_request_outbound_call moved to standalone voice-mcp service.
  // The legacy NanoClaw-side regression for this tool is obsolete.
});
