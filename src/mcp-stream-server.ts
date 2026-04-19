/**
 * src/mcp-stream-server.ts
 *
 * Phase 4 Plan 04-03 (AC-07): StreamableHTTP MCP transport for Chat-Claude.
 *
 * Port 3201 exposes the SAME ToolRegistry instance that the existing REST
 * fassade on port 3200 serves — single-source invariant. Chat-Claude on iPhone
 * (10.0.0.4) or iPad (10.0.0.5) `claude mcp add`-connects to
 * http://10.0.0.2:3201/mcp/stream with a bearer header.
 *
 * Pitfall 6: explicit bind to 10.0.0.2 (WG interface), NEVER 0.0.0.0.
 * Pitfall 8: every tool invocation from Chat synthesizes
 *   call_id  = 'chat-<uuid>'
 *   turn_id  = 'chat-<ts>-<slice>'
 * so the Phase-2 idempotency cache (and every handler's JSONL audit) has a
 * disjoint key space from live voice calls. A debug invocation can never
 * accidentally merge with an in-flight real call's idempotency result.
 *
 * Auth layering (cheap check first):
 *   1. /mcp/stream/health exempt — lets Claude Chat discovery poll it.
 *   2. Bearer auth — fixed token from OneCLI (MCP_STREAM_BEARER). 401 on
 *      missing / wrong token. No admin endpoints, no public surface.
 *   3. Peer allowlist — identical allowlist to the port-3200 server. 403
 *      when the WG peer is unlisted.
 *   4. StreamableHTTPServerTransport.handleRequest on POST/GET /mcp/stream.
 *
 * When MCP_STREAM_BEARER is unset, `startMcpStreamServer` skips startup with a
 * WARN log — no insecure open mode. `buildMcpStreamApp` will throw if called
 * without a bearer token (fail loud in tests).
 */
import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { logger } from './logger.js';
import { peerAllowlistMiddleware } from './peer-allowlist.js';
import {
  MCP_STREAM_PORT,
  MCP_STREAM_BIND,
  MCP_STREAM_BEARER,
} from './config.js';
import type { ToolRegistry } from './mcp-tools/index.js';

// Same allowlist as port 3200 (src/mcp-server.ts DEFAULT_ALLOWLIST).
// 10.0.0.1 Hetzner, 10.0.0.2 self, 10.0.0.4 iPhone, 10.0.0.5 iPad.
const DEFAULT_ALLOWLIST = ['10.0.0.1', '10.0.0.2', '10.0.0.4', '10.0.0.5'];

type StreamLog = Pick<typeof logger, 'info' | 'warn' | 'error' | 'fatal'>;

export interface McpStreamDeps {
  registry: ToolRegistry;
  /** Bearer required on every request except /mcp/stream/health. */
  bearerToken?: string;
  allowlist?: string[];
  log?: StreamLog;
}

/**
 * Build the Express application exposing the StreamableHTTP MCP transport.
 * Throws if no bearer token is supplied — there is no insecure default.
 */
export function buildMcpStreamApp(deps: McpStreamDeps): express.Application {
  const bearer = deps.bearerToken ?? MCP_STREAM_BEARER;
  if (!bearer) {
    throw new Error(
      'mcp-stream: MCP_STREAM_BEARER must be set — refusing to boot without auth',
    );
  }
  const log: StreamLog = deps.log ?? logger;
  const allowlist = deps.allowlist ?? DEFAULT_ALLOWLIST;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // -------------------------------------------------------------------------
  // /mcp/stream/health BEFORE auth — lets Claude Chat discovery hit it.
  // -------------------------------------------------------------------------
  app.get('/mcp/stream/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      ts: Date.now(),
      bound_to: MCP_STREAM_BIND,
      tools: deps.registry.listNames(),
    });
  });

  // -------------------------------------------------------------------------
  // Layer 1: Bearer auth — cheap header check before allowlist lookup.
  // -------------------------------------------------------------------------
  app.use((req: Request, res: Response, next) => {
    if (req.path === '/mcp/stream/health') {
      next();
      return;
    }
    const header = req.header('Authorization') ?? '';
    if (header !== `Bearer ${bearer}`) {
      log.warn(
        {
          event: 'mcp_stream_auth_fail',
          peer: req.socket.remoteAddress,
          path: req.path,
        },
        'MCP stream auth failed',
      );
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // -------------------------------------------------------------------------
  // Layer 2: Peer allowlist — identical policy to port 3200.
  // -------------------------------------------------------------------------
  app.use(
    peerAllowlistMiddleware(allowlist, log as Pick<typeof logger, 'warn'>),
  );

  // -------------------------------------------------------------------------
  // MCP server + transport are built PER REQUEST (stateless mode).
  //
  // Per MCP SDK spec, an McpServer instance can only be connected to one
  // transport at a time, and a transport can only be initialized once.
  // Reusing a single instance across requests makes the second client's
  // `initialize` JSON-RPC call fail with "Server already initialized"
  // (-32600). The canonical fix is to spawn a fresh Server+Transport pair
  // inside the request handler and tear them down when the response closes.
  //
  // Tool registration is factored out so the per-request build stays cheap
  // (no network I/O, no zod re-compilation).
  //
  // Handler wrappers are Pitfall-8-safe: they do NOT re-validate args (the
  // Core handler has its own zod schema), they just prefix synthetic
  // chat-<uuid> call_id / turn_id so the Phase-2 idempotency cache stays
  // disjoint from live voice calls.
  // -------------------------------------------------------------------------
  // Tool metadata for MCP clients (iOS Claude app, Claude Desktop).
  // Without description + paramsSchema, `tools/list` returns empty input
  // schemas and MCP clients cannot construct a valid tools/call request.
  // Only tools iOS is expected to invoke directly need full metadata here;
  // others register with a generic description and a permissive passthrough
  // schema so the client at least sees them in the list.
  const TOOL_META: Record<
    string,
    { description: string; shape?: z.ZodRawShape }
  > = {
    'voice.check_calendar': {
      description:
        'Check calendar availability for a given date and duration. Returns available/conflict + free slots.',
      shape: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('ISO date YYYY-MM-DD'),
        duration_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .describe('Requested duration in minutes'),
      },
    },
    'voice.get_day_month_cost_sum': {
      description:
        'Return today and this-month voice-call cost totals in EUR, plus whether the channel is suspended by the monthly cap.',
      // no parameters
    },
    'voice.get_travel_time': {
      description:
        'Google Maps travel time between origin and destination in seconds.',
      shape: {
        origin: z
          .string()
          .describe('Origin address or lat,lng (e.g. "Marienplatz, München")'),
        destination: z.string().describe('Destination address or lat,lng'),
        mode: z
          .enum(['driving', 'transit', 'walking', 'bicycling'])
          .optional()
          .describe('Travel mode, default "driving"'),
      },
    },
    'voice.ask_core': {
      description:
        'Ask the Core (Slow-Brain) a free-form question. Returns a voice-short answer plus optional Discord-long context.',
      shape: {
        question: z.string().describe('Natural-language question for Core'),
      },
    },
  };

  const registerTools = (server: McpServer): void => {
    for (const name of deps.registry.listNames()) {
      const meta = TOOL_META[name];
      const description = meta?.description ?? `Voice MCP tool: ${name}`;
      const handler = async (args: unknown) => {
        const synthetic =
          args && typeof args === 'object' && !Array.isArray(args)
            ? {
                ...(args as Record<string, unknown>),
                call_id: `chat-${crypto.randomUUID()}`,
                turn_id: `chat-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
              }
            : args;
        const result = await deps.registry.invoke(name, synthetic);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      };
      if (meta?.shape) {
        server.tool(name, description, meta.shape, handler);
      } else {
        server.tool(name, description, handler);
      }
    }
  };

  app.all('/mcp/stream', async (req: Request, res: Response) => {
    const mcp = new McpServer({
      name: 'nanoclaw-voice',
      version: '1.0.0',
    });
    registerTools(mcp);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — one transport per request
    });

    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void mcp.close().catch(() => undefined);
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.warn(
        {
          event: 'mcp_stream_request_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'MCP stream handleRequest threw',
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal' });
      }
    }
  });

  return app;
}

/**
 * Start the StreamableHTTP MCP server. Returns null (no startup) when
 * MCP_STREAM_BEARER is unset — that is a deliberate degrade mode for dev
 * hosts without secrets provisioned.
 */
export function startMcpStreamServer(deps: McpStreamDeps): HttpServer | null {
  if (!MCP_STREAM_BEARER) {
    logger.warn(
      {
        event: 'mcp_stream_server_not_started',
        reason: 'MCP_STREAM_BEARER unset — skipping StreamableHTTP startup',
      },
      'MCP stream server not started — no bearer configured',
    );
    return null;
  }
  const app = buildMcpStreamApp(deps);
  const server = app.listen(MCP_STREAM_PORT, MCP_STREAM_BIND, () => {
    logger.info(
      {
        event: 'mcp_stream_server_started',
        bind: MCP_STREAM_BIND,
        port: MCP_STREAM_PORT,
        tools: deps.registry.listNames(),
      },
      `MCP stream server listening on ${MCP_STREAM_BIND}:${MCP_STREAM_PORT}`,
    );
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal(
        {
          event: 'mcp_stream_bind_failed',
          bind: MCP_STREAM_BIND,
          port: MCP_STREAM_PORT,
          err,
        },
        `MCP stream server cannot bind ${MCP_STREAM_BIND}:${MCP_STREAM_PORT} — port in use`,
      );
      process.exit(1);
    }
    logger.error({ event: 'mcp_stream_server_error', err });
  });
  return server;
}
