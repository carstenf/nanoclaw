/**
 * src/mcp-stream-server.ts
 *
 * Phase 4.5 Plan 01 (AC-07, D-2/D-3/D-4/D-11): StreamableHTTP MCP transport
 * for Chat-Claude AND voice-bridge, session-based mode.
 *
 * Port 3201 exposes the SAME ToolRegistry instance that the existing REST
 * fassade on port 3200 serves — single-source invariant. Chat-Claude on
 * iPhone (10.0.0.4) or iPad (10.0.0.5) connects through the Hetzner Caddy
 * route at https://mcp.carstenfreek.de/nanoclaw-voice/ — consistent with
 * the other single-level Caddy MCP paths (/hetzner/, /discord/, /lenovo1/).
 *
 * CHANGE FROM WAVE-3 (stateless → session-based):
 * - `sessionIdGenerator: () => randomUUID()` — the SDK assigns a unique
 *   Mcp-Session-Id per initialize, returns it in the response header, and
 *   expects clients to echo it on subsequent requests.
 * - Session Map keyed by sid → { server, transport, ... }. Per-session
 *   McpServer (Pitfall 1 / SDK Issue #1405) — NEVER share across sessions.
 * - Idle TTL sweep (60s interval, unref'd) closes sessions inactive >30min.
 *   Active sessions bump `lastActivity` on every request — never swept.
 * - Cap at MCP_STREAM_MAX_SESSIONS (default 50) — excess initialize returns
 *   503 `session_cap_reached`. Non-initialize without sid returns 400
 *   `session_required` (JSON-RPC envelope).
 * - `capabilities.tools.listChanged: false` advertised BEFORE connect()
 *   (Anti-Pattern: registerCapabilities after connect throws per SDK).
 *
 * Pitfall 6: explicit bind to 10.0.0.2 (WG interface), NEVER 0.0.0.0.
 * Pitfall 8: every tool invocation from Chat synthesizes
 *   call_id  = 'chat-<uuid>'
 *   turn_id  = 'chat-<ts>-<slice>'
 * so the Phase-2 idempotency cache (and every handler's JSONL audit) has a
 * disjoint key space from live voice calls (D-11 locks this in createSession).
 *
 * Auth layering (cheap check first):
 *   1. /health exempt — lets Claude Chat discovery poll it.
 *   2. Bearer auth — fixed token from OneCLI (MCP_STREAM_BEARER). 401 on
 *      missing / wrong token.
 *   3. Peer allowlist — identical allowlist to the port-3200 server. 403
 *      when the WG peer is unlisted.
 *   4. Session lookup / create → StreamableHTTPServerTransport.handleRequest.
 *
 * When MCP_STREAM_BEARER is unset, `startMcpStreamServer` skips startup with
 * a WARN log — no insecure open mode. `buildMcpStreamApp` throws if called
 * without a bearer token (fail loud in tests).
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { logger } from './logger.js';
import { peerAllowlistMiddleware } from './peer-allowlist.js';
import {
  MCP_STREAM_PORT,
  MCP_STREAM_BIND,
  MCP_STREAM_BEARER,
  MCP_STREAM_SESSION_TTL_MS,
  MCP_STREAM_MAX_SESSIONS,
} from './config.js';
import type { ToolRegistry } from './mcp-tools/index.js';

// Wave-0 re-exported zod schemas — one per voice.* tool. Each TOOL_META
// entry references `<X>Schema.shape` so SDK `server.tool()` receives a
// ZodRawShape and converts it to JSON-Schema for tools/list.
import { CheckCalendarSchema } from './mcp-tools/voice-check-calendar.js';
import { CreateEntrySchema } from './mcp-tools/voice-create-calendar-entry.js';
import { DeleteEntrySchema } from './mcp-tools/voice-delete-calendar-entry.js';
import { UpdateEntrySchema } from './mcp-tools/voice-update-calendar-entry.js';
import { SendDiscordMessageSchema } from './mcp-tools/voice-send-discord-message.js';
import { TravelTimeSchema } from './mcp-tools/voice-get-travel-time.js';
import { GetContractSchema } from './mcp-tools/voice-get-contract.js';
import { GetPracticeProfileSchema } from './mcp-tools/voice-get-practice-profile.js';
import { ScheduleRetrySchema } from './mcp-tools/voice-schedule-retry.js';
import { AskCoreSchema } from './mcp-tools/voice-ask-core.js';
import { RecordTurnCostSchema } from './mcp-tools/voice-record-turn-cost.js';
import { FinalizeCallCostSchema } from './mcp-tools/voice-finalize-call-cost.js';
import { InsertPriceSnapshotSchema } from './mcp-tools/voice-insert-price-snapshot.js';
import { SearchCompetitorsSchema } from './mcp-tools/voice-search-competitors.js';
import { RequestOutboundCallSchema } from './mcp-tools/voice-request-outbound-call.js';
import { ResetMonthlyCapSchema } from './mcp-tools/voice-reset-monthly-cap.js';
import { GetDayMonthCostSumSchema } from './mcp-tools/voice-get-day-month-cost-sum.js';
import { OnTranscriptTurnSchema } from './mcp-tools/voice-on-transcript-turn.js';
import { VoiceNotifyUserSchema } from './mcp-tools/voice-notify-user.js';
import { VoiceStartCase2CallSchema } from './mcp-tools/voice-start-case-2-call.js';
import { VoiceCase2ScheduleRetrySchema } from './mcp-tools/voice-case-2-retry.js';
import { VoiceOutboundScheduleRetrySchema } from './mcp-tools/voice-outbound-retry.js';
import { VoiceTriggersInitSchema } from './mcp-tools/voice-triggers-init.js';
import { VoiceTriggersTranscriptSchema } from './mcp-tools/voice-triggers-transcript.js';
import { VoiceRespondSchema } from './mcp-tools/voice-respond.js';

// Same allowlist as port 3200 (src/mcp-server.ts DEFAULT_ALLOWLIST).
// 10.0.0.1 Hetzner, 10.0.0.2 self, 10.0.0.4 iPhone, 10.0.0.5 iPad.
// Phase 05.4 Bug-2 follow-up: Docker-bridge subnet added so the container-
// agent (dynamic IP inside 172.17.0.0/16) can reach the MCP stream server via
// host.docker.internal. Bearer auth (MCP_STREAM_BEARER) remains mandatory at
// Layer 1 — the CIDR only widens the peer allowlist after bearer validation.
// UFW rule on Lenovo1 restricts ingress to this CIDR + port 3201 only.
//
// Phase 05.6 Plan 02 follow-up: 127.0.0.1 / ::1 added so the voice-bridge
// (co-located on Lenovo1, per /opt/server-docs/MASTER.md + project memory
// `project_nanoclaw_infra`) can reach this server via local loopback —
// the documented Bridge → NanoClaw transport address is http://127.0.0.1:3201/.
// Loopback is intra-host only (kernel never routes 127.0.0.0/8 off-box) so
// adding it does not widen the external attack surface.
const DEFAULT_ALLOWLIST = [
  '127.0.0.1',
  '::1',
  '10.0.0.1',
  '10.0.0.2',
  '10.0.0.4',
  '10.0.0.5',
  '172.17.0.0/16',
];

type StreamLog = Pick<typeof logger, 'info' | 'warn' | 'error' | 'fatal'>;

export interface McpStreamDeps {
  registry: ToolRegistry;
  /** Bearer required on every request except /health. */
  bearerToken?: string;
  allowlist?: string[];
  log?: StreamLog;
}

// -----------------------------------------------------------------------------
// TOOL_META — 18 voice.* tools.
//
// Each entry carries a non-generic description AND a zod-raw-shape input
// schema derived from the handler's own validation schema (exported in
// Wave 0). `server.tool(name, description, shape, handler)` enforces zod
// pre-handler and publishes the inputSchema on tools/list so MCP clients
// (iOS Claude-App, Claude Desktop) see full semantics.
//
// `skipSyntheticIds` (optional) opts a tool out of Pitfall-8 chat/iOS
// synthetic call_id/turn_id wrapping. Set true for tools that carry the
// REAL Bridge↔NanoClaw call_id and MUST NOT have it overwritten — else
// (a) cost-ledger attribution breaks, and (b) cross-tool correlation
// between voice_ask_core (registers Promise on call_id A) and
// voice_respond (resolves on call_id B) misses every time.
//
// Mitigation T-4.5-D (Tampering via malformed args): zod shape validation
// bounds the set of inputs that reach the handler.
// -----------------------------------------------------------------------------
interface ToolMeta {
  description: string;
  shape: z.ZodRawShape;
  skipSyntheticIds?: boolean;
}
const TOOL_META: Record<string, ToolMeta> =
  {
    'voice_check_calendar': {
      description:
        'Check calendar availability for a given date and duration. Returns available/conflicts + free slots.',
      shape: CheckCalendarSchema.shape,
    },
    'voice_create_calendar_entry': {
      description:
        'Create a calendar entry with date/time/title/attendees. Idempotent via call_id+turn_id.',
      shape: CreateEntrySchema.shape,
    },
    'voice_delete_calendar_entry': {
      description: 'Delete a calendar entry by id.',
      shape: DeleteEntrySchema.shape,
    },
    'voice_update_calendar_entry': {
      description: 'Update selected fields of a calendar entry.',
      shape: UpdateEntrySchema.shape,
    },
    'voice_send_discord_message': {
      description:
        'Send a Discord DM to Carsten — idempotent via content hash.',
      shape: SendDiscordMessageSchema.shape,
    },
    'voice_get_travel_time': {
      description:
        'Get travel time from origin to destination via Google Maps Distance Matrix.',
      shape: TravelTimeSchema.shape,
    },
    'voice_get_contract': {
      description: 'Read the current Core contract document (read-only).',
      shape: GetContractSchema.shape,
    },
    'voice_get_practice_profile': {
      description:
        'Read the practice profile (address, patient_id, authorized fields).',
      shape: GetPracticeProfileSchema.shape,
    },
    'voice_schedule_retry': {
      description: 'Schedule a retry of a failed outbound call.',
      shape: ScheduleRetrySchema.shape,
    },
    'voice_ask_core': {
      description:
        'Async query to the Slow-Brain — returns instructions_update patch.',
      shape: AskCoreSchema.shape,
      skipSyntheticIds: true,
    },
    'voice_record_turn_cost': {
      description:
        'Record a per-turn usage cost into the cost ledger. Idempotent via (call_id, turn_id).',
      shape: RecordTurnCostSchema.shape,
    },
    'voice_finalize_call_cost': {
      description:
        'Finalize the aggregated cost for a voice call on hangup.',
      shape: FinalizeCallCostSchema.shape,
    },
    'voice_insert_price_snapshot': {
      description: 'Insert a pricing snapshot for drift detection.',
      shape: InsertPriceSnapshotSchema.shape,
    },
    'voice_search_competitors': {
      description:
        'Search for competitor offers (graceful not_configured fallback).',
      shape: SearchCompetitorsSchema.shape,
    },
    'voice_request_outbound_call': {
      description:
        'Request an outbound call — NanoClaw→Bridge (Case 6b).',
      shape: RequestOutboundCallSchema.shape,
    },
    'voice_reset_monthly_cap': {
      description: 'Reset the monthly cost cap counter.',
      shape: ResetMonthlyCapSchema.shape,
    },
    'voice_get_day_month_cost_sum': {
      description:
        'Return today + current-month cumulative cost in EUR.',
      shape: GetDayMonthCostSumSchema.shape,
    },
    'voice_on_transcript_turn': {
      description:
        'Bridge→Core: push a transcript turn for Slow-Brain processing.',
      shape: OnTranscriptTurnSchema.shape,
    },
    'voice_notify_user': {
      description:
        'Notify Carsten via the most-recent active channel (WhatsApp/Discord) with >50-word override to Discord.',
      shape: VoiceNotifyUserSchema.shape,
    },
    'voice_start_case_2_call': {
      description:
        'Trigger a Case-2 outbound restaurant-reservation call (D-5 args, D-7 idempotency).',
      shape: VoiceStartCase2CallSchema.shape,
    },
    'voice_case_2_schedule_retry': {
      description:
        'Schedule a Case-2 retry with ladder (5/15/45/120 min) and daily cap of 5.',
      shape: VoiceCase2ScheduleRetrySchema.shape,
    },
    'voice_outbound_schedule_retry': {
      description:
        'Generic outbound retry with the same 5/15/45/120-min ladder and 5/day cap. Use for any outbound voicemail; no calendar_date or idempotency_key required.',
      shape: VoiceOutboundScheduleRetrySchema.shape,
    },
    'voice_triggers_init': {
      description:
        'Container-agent reasoning trigger — synchronous at /accept. Returns fully-rendered persona instructions string.',
      shape: VoiceTriggersInitSchema.shape,
      skipSyntheticIds: true,
    },
    'voice_triggers_transcript': {
      description:
        'Container-agent reasoning trigger — per-turn FIFO. Returns instructions_update string or null.',
      shape: VoiceTriggersTranscriptSchema.shape,
      skipSyntheticIds: true,
    },
    'voice_respond': {
      description:
        'Andy → Voice: deliver the result of a voice_request injected into the existing whatsapp_main container. Args: {call_id, voice_short, discord_long?}. Resolves the pending ask_core Promise.',
      shape: VoiceRespondSchema.shape,
      skipSyntheticIds: true,
    },
  };

/**
 * Per-session state — one entry per live Mcp-Session-Id.
 *
 * Invariants:
 * - `server` is a fresh `new McpServer(...)` per session (Pitfall 1: SDK
 *   Issue #1405 — shared McpServer causes concurrent-session hangs).
 * - `transport` is the unique StreamableHTTPServerTransport bound to this
 *   session; its sessionId matches the Map key.
 * - `lastActivity` is bumped on every request that lands on this session;
 *   idle sweep only evicts sessions where `now - lastActivity >= TTL`.
 */
interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  sessionId: string;
  createdAt: number;
  lastActivity: number;
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

  // Session store is PER-APP (not per-request, not module-scope) so each
  // buildMcpStreamApp() call — including test-fixture rebuilds on ephemeral
  // ports — gets an isolated Map. Production boots this exactly once.
  const sessions = new Map<string, Session>();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // -------------------------------------------------------------------------
  // /health BEFORE auth — lets Claude Chat discovery hit it.
  // Mounted at the Express root (not /mcp/stream/health) so the public URL
  // pattern is `https://mcp.carstenfreek.de/nanoclaw-voice/health`,
  // consistent with the other Hetzner Caddy routes (/hetzner/, /discord/,
  // /lenovo1/ — all single-level, no protocol suffix).
  // -------------------------------------------------------------------------
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      ts: Date.now(),
      bound_to: MCP_STREAM_BIND,
      tools: deps.registry.listNames(),
      sessions: sessions.size,
    });
  });

  // -------------------------------------------------------------------------
  // Layer 1: Bearer auth — cheap header check before allowlist lookup.
  // -------------------------------------------------------------------------
  app.use((req: Request, res: Response, next) => {
    if (req.path === '/health') {
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
  // createSession — instantiated on every initialize request that passes
  // the cap check. One fresh McpServer + one fresh transport per session.
  //
  // PITFALL 1 (SDK Issue #1405): NEVER share McpServer across sessions —
  //   the SDK's Protocol.connect() silently overwrites `this._transport`,
  //   making session A's pending tools/call abort when session B connects.
  //
  // PITFALL 8 (D-11): synthetic call_id/turn_id wrapping lives inside each
  //   per-session tool handler so chat/iOS clients get a disjoint
  //   idempotency key space regardless of which session they opened.
  //
  // ANTI-PATTERN: `registerCapabilities` MUST precede `mcp.connect(transport)`
  //   — the SDK throws "Cannot register capabilities after connecting to a
  //   transport" otherwise. The call comes AFTER .tool() so its
  //   {listChanged:false} overrides the SDK's auto-injected {listChanged:true}.
  // -------------------------------------------------------------------------
  const createSession = async (): Promise<Session> => {
    const mcp = new McpServer({ name: 'nanoclaw-voice', version: '1.0.0' });

    for (const name of deps.registry.listNames()) {
      const meta = TOOL_META[name];
      const description = meta?.description ?? `Voice MCP tool: ${name}`;
      // Pitfall-8 opt-out: tools carrying the REAL Bridge↔NanoClaw call_id
      // (voice_triggers_*, voice_ask_core, voice_respond) flag themselves via
      // TOOL_META.skipSyntheticIds. See ToolMeta jsdoc above for the why.
      const skipSyntheticIds = meta?.skipSyntheticIds ?? false;
      const handler = async (args: unknown) => {
        // Pitfall 8: every chat/iOS invocation gets synthetic IDs so its
        // idempotency keys are disjoint from live voice calls. Skipped for
        // voice_triggers_* (see comment above).
        const synthetic =
          !skipSyntheticIds &&
          args &&
          typeof args === 'object' &&
          !Array.isArray(args)
            ? {
                ...(args as Record<string, unknown>),
                call_id: `chat-${randomUUID()}`,
                turn_id: `chat-${Date.now()}-${randomUUID().slice(0, 8)}`,
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
        mcp.tool(name, description, meta.shape, handler);
      } else {
        // Tool registered at runtime without TOOL_META entry — log once so
        // we surface drift. Still registerable with a generic description.
        log.warn(
          { event: 'mcp_tool_missing_meta', tool_name: name },
          'tool registered without TOOL_META entry — client will see empty inputSchema',
        );
        mcp.tool(name, description, handler);
      }
    }

    // Override SDK default: .tool() auto-sets {tools:{listChanged:true}} on
    // the internal capabilities map; we want {listChanged:false} so iOS does
    // not open a long-running GET for notifications/tools/list_changed.
    // Must come BEFORE connect(transport).
    mcp.server.registerCapabilities({ tools: { listChanged: false } });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        const now = Date.now();
        sessions.set(sid, {
          server: mcp,
          transport,
          sessionId: sid,
          createdAt: now,
          lastActivity: now,
        });
        log.info(
          { event: 'mcp_session_opened', sid: sid.slice(0, 8), createdAt: now },
          'MCP session opened',
        );
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.delete(sid)) {
        log.info(
          {
            event: 'mcp_session_closed',
            sid: sid.slice(0, 8),
            reason: 'transport_close',
          },
          'MCP session closed',
        );
      }
    };

    await mcp.connect(transport);
    return {
      server: mcp,
      transport,
      sessionId: transport.sessionId ?? '',
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
  };

  // -------------------------------------------------------------------------
  // Main MCP handler — routes by Mcp-Session-Id. Cap-check + session-required
  // branches return structured 4xx/5xx responses BEFORE handing off to the
  // SDK's handleRequest (so they don't get logged as transport failures).
  // -------------------------------------------------------------------------
  app.all('/', async (req: Request, res: Response) => {
    const sid = req.header('Mcp-Session-Id');
    let session: Session | undefined = sid ? sessions.get(sid) : undefined;

    if (session) {
      session.lastActivity = Date.now();
    } else {
      // Miss: either unknown sid OR no sid supplied. Only initialize may
      // create a new session.
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'session_required' },
          id: null,
        });
        return;
      }
      if (sessions.size >= MCP_STREAM_MAX_SESSIONS) {
        log.warn(
          {
            event: 'mcp_session_cap_rejected',
            peer: req.socket.remoteAddress,
            current_sessions: sessions.size,
            cap: MCP_STREAM_MAX_SESSIONS,
          },
          'MCP session cap reached — rejecting initialize',
        );
        res.status(503).json({ error: 'session_cap_reached' });
        return;
      }
      try {
        session = await createSession();
      } catch (err) {
        log.warn(
          {
            event: 'mcp_stream_request_failed',
            err: err instanceof Error ? err.message : String(err),
          },
          'createSession threw during initialize',
        );
        if (!res.headersSent) res.status(500).json({ error: 'internal' });
        return;
      }
    }

    try {
      await session.transport.handleRequest(req, res, req.body);
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

  // -------------------------------------------------------------------------
  // Idle sweep — every 60s, evict sessions whose lastActivity is older than
  // MCP_STREAM_SESSION_TTL_MS. Active sessions (bumped on every request) are
  // never swept. Cleanup is fire-and-forget with .catch() per Pitfall 4
  // (transport.close() + server.close() idempotency).
  // -------------------------------------------------------------------------
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.lastActivity > MCP_STREAM_SESSION_TTL_MS) {
        void s.transport.close().catch(() => undefined);
        void s.server.close().catch(() => undefined);
        sessions.delete(sid);
        log.info(
          {
            event: 'mcp_session_swept',
            sid: sid.slice(0, 8),
            age_ms: now - s.createdAt,
          },
          'MCP session swept (idle TTL exceeded)',
        );
      }
    }
  }, 60_000);
  sweeper.unref();

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
        session_ttl_ms: MCP_STREAM_SESSION_TTL_MS,
        max_sessions: MCP_STREAM_MAX_SESSIONS,
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
