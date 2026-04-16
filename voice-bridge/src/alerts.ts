// src/alerts.ts — Discord ALERT delivery for heartbeat failures
// Uses native fetch (Node 22 built-in) with AbortController timeout.
// If DISCORD_ALERT_WEBHOOK_URL is unset, degrades gracefully to JSONL-only.
export async function sendDiscordAlert(message: string): Promise<void> {
  // Read from env at call time (not module load) so tests can set it in beforeEach.
  const url = process.env.DISCORD_ALERT_WEBHOOK_URL ?? ''
  if (!url) return // graceful degrade — JSONL is audit trail of last resort
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
  } catch {
    // alert delivery failed — JSONL log is the audit trail of last resort
  }
}
