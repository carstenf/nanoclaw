// voice-bridge/src/index.ts
// PER PITFALL NEW-4: addContentTypeParser('application/json', ...)
// REPLACES the global JSON parser. If Phase 2+ adds a route that needs
// default JSON behavior without rawBody, switch to fastify-raw-body
// plugin and per-route config.rawBody=true.
import Fastify from 'fastify'
import OpenAI from 'openai'
import { HOST, PORT, getSecret, getApiKey, getWhitelist } from './config.js'
import { buildLogger } from './logger.js'
import { registerHealthRoute } from './health.js'
import { registerWebhookRoute, registerAcceptRoute } from './webhook.js'
import { registerOutboundRoute } from './outbound-webhook.js'
import { startHeartbeat } from './heartbeat.js'
import { createCallRouter, type CallRouter } from './call-router.js'
import { createOutboundRouter, type OutboundRouter } from './outbound-router.js'

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

  const router = opts.routerOverride ?? createCallRouter()

  // OutboundRouter: DI for tests, real instance in production
  const outboundRouter =
    opts.outboundRouterOverride ??
    createOutboundRouter({
      openaiClient: openai as unknown as Parameters<typeof createOutboundRouter>[0]['openaiClient'],
      callRouter: router,
      reportBack: async () => {
        /* report-back wired in main() via log; no-op in buildApp */
      },
      timers: { setTimeout, clearTimeout },
    })

  registerHealthRoute(app)
  registerWebhookRoute(app, openai, log, secret)
  registerAcceptRoute(app, openai, log, secret, whitelist, router)
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
