// src/health.ts — GET /health handler
// Returns shape: {ok, secret_loaded, uptime_s, bind, port}
// Phase 1: secret_loaded is static true (config.ts exits on missing secret).
// Phase 2 will add wg_ok from heartbeat state.
import type { FastifyInstance } from 'fastify'
import { HOST, PORT } from './config.js'

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async () => {
    return {
      ok: true,
      secret_loaded: true,
      uptime_s: Math.round(process.uptime()),
      bind: HOST,
      port: PORT,
    }
  })
}
