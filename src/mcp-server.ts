import http from 'http';

import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { peerAllowlistMiddleware } from './peer-allowlist.js';
import {
  ToolRegistry,
  UnknownToolError,
  buildDefaultRegistry,
} from './mcp-tools/index.js';
import { BadRequestError } from './mcp-tools/voice-on-transcript-turn.js';

const DEFAULT_PORT = 3200;
const DEFAULT_BIND = '10.0.0.2';
// 10.0.0.1 = Hetzner (Bridge-Migration Option C reserved)
// 10.0.0.2 = Lenovo1 self (current voice-bridge deployment host)
// 10.0.0.4 = iPhone Chat debug
// 10.0.0.5 = iPad Chat debug
const DEFAULT_ALLOWLIST = ['10.0.0.1', '10.0.0.2', '10.0.0.4', '10.0.0.5'];

export interface McpDeps {
  registry: ToolRegistry;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error' | 'fatal'>;
  allowlist: string[];
  boundTo: string;
}

export function buildMcpApp(deps: McpDeps): express.Application {
  const log = deps.log ?? logger;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(peerAllowlistMiddleware(deps.allowlist, log));

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      ts: Date.now(),
      bound_to: deps.boundTo,
      peers: deps.allowlist,
      tools: deps.registry.listNames(),
    });
  });

  app.post('/mcp/:tool_name', async (req: Request, res: Response) => {
    const rawName = req.params.tool_name;
    const toolName = Array.isArray(rawName) ? rawName[0] : rawName;
    const args =
      (req.body && (req.body as Record<string, unknown>).arguments) ?? {};
    const started = Date.now();
    try {
      const result = await deps.registry.invoke(toolName, args);
      log.info({
        event: 'mcp_tool_invoked',
        tool_name: toolName,
        peer_ip: req.socket.remoteAddress,
        status_code: 200,
        latency_ms: Date.now() - started,
      });
      res.status(200).json({ ok: true, result });
    } catch (err) {
      if (err instanceof UnknownToolError) {
        res.status(404).json({ error: 'unknown_tool', tool_name: toolName });
        return;
      }
      if (err instanceof BadRequestError) {
        res.status(400).json({
          error: 'bad_request',
          field: err.field,
          expected: err.expected,
        });
        return;
      }
      const refId = `${started}-${Math.random().toString(36).slice(2, 8)}`;
      log.error({
        event: 'mcp_tool_internal_error',
        tool_name: toolName,
        ref_id: refId,
        err,
      });
      res.status(500).json({ error: 'internal', ref_id: refId });
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (
      err &&
      typeof err === 'object' &&
      'type' in err &&
      (err as { type?: string }).type === 'entity.parse.failed'
    ) {
      res.status(400).json({ error: 'bad_json' });
      return;
    }
    log.error({ event: 'mcp_unhandled', err });
    res.status(500).json({ error: 'internal' });
  });

  return app;
}

export interface StartMcpServerOpts {
  registry?: ToolRegistry;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error' | 'fatal'>;
}

export function startMcpServer(opts: StartMcpServerOpts = {}): http.Server {
  const env = readEnvFile([
    'MCP_SERVER_PORT',
    'MCP_SERVER_BIND',
    'MCP_PEER_ALLOWLIST',
  ]);
  const port = parseInt(
    process.env.MCP_SERVER_PORT || env.MCP_SERVER_PORT || String(DEFAULT_PORT),
    10,
  );
  const bind =
    process.env.MCP_SERVER_BIND || env.MCP_SERVER_BIND || DEFAULT_BIND;
  const allowlistCsv =
    process.env.MCP_PEER_ALLOWLIST ||
    env.MCP_PEER_ALLOWLIST ||
    DEFAULT_ALLOWLIST.join(',');
  const allowlist = allowlistCsv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const log = opts.log ?? logger;
  const registry = opts.registry ?? buildDefaultRegistry({ log });
  const app = buildMcpApp({
    registry,
    log,
    allowlist,
    boundTo: `${bind}:${port}`,
  });

  const server = http.createServer(app);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.fatal(
        { event: 'mcp_bind_failed', bind, port, err },
        `MCP server cannot bind ${bind}:${port} — port in use`,
      );
      process.exit(1);
    }
    log.error({ event: 'mcp_server_error', err });
  });

  server.listen(port, bind, () => {
    log.info(
      {
        event: 'mcp_server_started',
        bind,
        port,
        allowlist,
        tools: registry.listNames(),
      },
      `MCP server listening on ${bind}:${port}`,
    );
  });

  return server;
}
