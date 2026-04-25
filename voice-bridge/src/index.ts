// voice-bridge/src/index.ts
// Phase 05.3 — Fastify app bootstrap + dependency wiring. Constructs the
// OpenAI client, Fastify instance, call-router + outbound-router, and
// registers all HTTP routes (/health, /webhook, /accept, /outbound).
//
// addContentTypeParser('application/json', ...) REPLACES the global JSON parser
// to preserve rawBody for HMAC re-verification in /webhook + /accept. If a
// future route needs default JSON behavior without rawBody, switch to
// fastify-raw-body plugin and per-route config.rawBody=true.
import Fastify from 'fastify'
import OpenAI from 'openai'
import {
  HOST,
  PORT,
  getSecret,
  getApiKey,
  getWhitelist,
  NANOCLAW_VOICE_MCP_URL,
  NANOCLAW_VOICE_MCP_TOKEN,
  NANOCLAW_VOICE_MCP_TIMEOUT_MS,
} from './config.js'
import { buildLogger } from './logger.js'
import { registerHealthRoute } from './health.js'
import { registerWebhookRoute, registerAcceptRoute } from './webhook.js'
import { registerOutboundRoute } from './outbound-webhook.js'
import { startHeartbeat } from './heartbeat.js'
import { createCallRouter, type CallRouter } from './call-router.js'
import { createOutboundRouter, type OutboundRouter } from './outbound-router.js'
import { setHangupCallback } from './tools/dispatch.js'
import { sipgateRestOriginate } from './sipgate-rest-client.js'
import { NanoclawMcpClient } from './nanoclaw-mcp-client.js'
// ESL client kept as inactive v2 fallback (Sipgate REST API pivot 2026-04-19).
// Will be re-wired if Sipgate account is upgraded from Basic to Trunking.
// import { eslOriginate } from './freeswitch-esl-client.js'

export interface BuildAppOptions {
  /** Optional OpenAI client injection for tests (mock). If omitted, real client is constructed. */
  openaiOverride?: OpenAI
  /** Optional whitelist override for tests. */
  whitelistOverride?: Set<string>
  /** If true, skip OPENAI_API_KEY load (tests that don't touch /accept). */
  skipApiKey?: boolean
  /** Optional CallRouter injection for tests — mock the Phase-2 per-call lifecycle. */
  routerOverride?: CallRouter
  /** Optional OutboundRouter injection for tests. */
  outboundRouterOverride?: OutboundRouter
  /** Optional Bearer auth token for /outbound (overrides env). */
  outboundAuthToken?: string
  /** Override peer IP for /outbound tests (bypasses real IP extraction). */
  peerIpOverride?: string
  /**
   * Optional NanoclawMcpClient injection for branch-coverage tests.
   * Production wiring constructs the client when NANOCLAW_VOICE_MCP_URL is set.
   */
  nanoclawMcpOverride?: NanoclawMcpClient
}

/**
 * Build and configure the Fastify app without binding to a port.
 * Exported for vitest injection (tests use app.inject without binding to 10.0.0.2).
 */
export async function buildApp(opts: BuildAppOptions = {}) {
  const log = buildLogger()
  const secret = getSecret()
  const openai =
    opts.openaiOverride ??
    new OpenAI({
      apiKey: opts.skipApiKey ? 'test-key' : getApiKey(),
      webhookSecret: secret,
    })
  const whitelist = opts.whitelistOverride ?? getWhitelist()
  const app = Fastify({ logger: false })

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(_req as any).rawBody = body
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  // Wire bridge-internal end_call hangup callback. Production uses the real
  // OpenAI client; tests can override per-call via DispatchOpts.hangupCall.
  setHangupCallback(async (callId: string) => {
    await (
      openai as unknown as {
        realtime: { calls: { hangup: (id: string) => Promise<unknown> } }
      }
    ).realtime.calls.hangup(callId)
  })

  // Forward declaration so call-router's onCallEndExtra can notify outbound-
  // router about call ends. The closure below captures the variable lazily —
  // outbound-router is constructed right after.
  let outboundRouter: OutboundRouter | undefined
  const router =
    opts.routerOverride ??
    createCallRouter({
      onCallEndExtra: async (callId, reason) => {
        if (!outboundRouter) return
        const taskId = outboundRouter.taskIdForOpenaiCallId(callId)
        if (taskId) await outboundRouter.onCallEnd(taskId, reason)
      },
    })

  // OutboundRouter — Sipgate originator + hangup callback (shared with
  // end_call). DI for tests, real instance in production.
  outboundRouter =
    opts.outboundRouterOverride ??
    createOutboundRouter({
      outboundOriginator: {
        originate: async ({ targetPhone, taskId }) => {
          const r = await sipgateRestOriginate({ callee: targetPhone, taskId })
          return { providerRef: r.sessionId }
        },
      },
      callRouter: router,
      reportBack: async (task) => {
        log.info(
          { event: 'outbound_task_done', task_id: task.task_id, status: task.status, error: task.error },
          'outbound task completed',
        )
      },
      hangupCall: async (callId: string) => {
        await (
          openai as unknown as {
            realtime: { calls: { hangup: (id: string) => Promise<unknown> } }
          }
        ).realtime.calls.hangup(callId)
      },
      log,
      timers: { setTimeout, clearTimeout },
    })

  // Per-process NanoclawMcpClient (D-3, D-21). Bridge talks to the
  // nanoclaw-voice MCP server on port 3201 for persona render
  // (voice_triggers_init / voice_triggers_transcript).
  const nanoclawMcp =
    opts.nanoclawMcpOverride ??
    (NANOCLAW_VOICE_MCP_URL
      ? new NanoclawMcpClient({
          url: NANOCLAW_VOICE_MCP_URL,
          bearer: NANOCLAW_VOICE_MCP_TOKEN,
          timeoutMs: NANOCLAW_VOICE_MCP_TIMEOUT_MS,
        })
      : undefined)

  registerHealthRoute(app)
  registerWebhookRoute(app, openai, log, secret)
  registerAcceptRoute(
    app,
    openai,
    log,
    secret,
    whitelist,
    router,
    outboundRouter,
    nanoclawMcp,
  )
  registerOutboundRoute(app, log, outboundRouter, {
    authToken: opts.outboundAuthToken,
    peerIpOverride: opts.peerIpOverride,
  })

  return app
}

async function main() {
  const app = await buildApp()

  // Obtain the logger from the app's built logger (re-build for main lifecycle logs)
  const log = buildLogger()

  await app.listen({ host: HOST, port: PORT })
  log.info({ event: 'bridge_listening', host: HOST, port: PORT })

  // Fire-and-forget: heartbeat lives for process lifetime
  void startHeartbeat(log).catch((err: Error) => {
    log.error({ event: 'heartbeat_died', err: err?.message })
  })
}

// Clean shutdown for systemd
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    // Best-effort close; if it hangs exit anyway
    process.exit(0)
  })
}

// Only run main() when executed directly (not imported by tests)
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/index.js') || process.argv[1].endsWith('/index.ts'))

if (isMain) {
  main().catch((err: Error) => {
    console.error('startup_failed', err?.message)
    process.exit(1)
  })
}
