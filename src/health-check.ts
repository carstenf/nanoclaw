// src/health-check.ts
//
// System health check for NanoClaw. Runs periodically (Phase4 cron, every 6h)
// and posts a summary to the Discord alert webhook so Carsten knows
// proactively when a subsystem is degraded — instead of finding out during
// a real call.
//
// Checks (each returns ok / warn / fail with a short detail):
//   - Channels (Discord, Gmail, …): isConnected()
//   - Voice-bridge alive: HEAD http://10.0.0.2:4402/health
//   - OneCLI gateway alive: TCP localhost:10255
//   - Sipgate REST API: GET https://api.sipgate.com/v2/account
//   - Google OAuth (Gmail + Calendar): expiry_date in token files —
//     fail if past, warn if <24h. Refresh failure is detected by the
//     Calendar tool itself; here we surface UPCOMING expiry.
//   - Container image present: `docker image inspect`
//
// Output: posted to DISCORD_ALERT_WEBHOOK_URL via the same `sendDiscordAlert`
// helper recon-3way / drift-monitor use.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import type { Channel } from './types.js';

export interface HealthCheckResult {
  /** Component name for the report line. */
  name: string;
  /** ok = green, warn = yellow (e.g. token expiring soon), fail = red. */
  status: 'ok' | 'warn' | 'fail';
  /** Short one-line detail for the report. */
  detail?: string;
}

export interface HealthCheckDeps {
  channels: Channel[];
  /**
   * Posts the rendered digest to Discord. Same shape recon-3way uses —
   * single string, never throws.
   */
  sendDiscordAlert: (message: string) => Promise<void>;
  /**
   * Voice-bridge health URL. Default `http://10.0.0.2:4402/health`. Override
   * for tests.
   */
  voiceBridgeHealthUrl?: string;
  /** OneCLI gateway TCP host:port. Default `localhost:10255`. */
  oneCliEndpoint?: { host: string; port: number };
  /** Path to Gmail credentials.json. Default `~/.gmail-mcp/credentials.json`. */
  gmailTokenPath?: string;
  /** Path to Calendar tokens.json. Default `~/.gcalendar-mcp/google-calendar-mcp/tokens.json`. */
  calendarTokenPath?: string;
  /** Container image tag to verify exists. Default from env or skipped. */
  containerImage?: string;
  /**
   * Sipgate REST API credentials. Falls back to process.env when omitted —
   * but under systemd .env is not auto-loaded, so callers should pass
   * explicit values from readEnvFile().
   */
  sipgateAuth?: { tokenId: string; token: string };
  /** Override `Date.now` for tests. */
  now?: () => number;
}

const DEFAULT_VOICE_BRIDGE_HEALTH = 'http://10.0.0.2:4402/health';
const DEFAULT_ONECLI = { host: 'localhost', port: 10255 };
const DEFAULT_TIMEOUT_MS = 3_000;

async function checkChannel(ch: Channel): Promise<HealthCheckResult> {
  try {
    return ch.isConnected()
      ? { name: `channel:${ch.name}`, status: 'ok' }
      : {
          name: `channel:${ch.name}`,
          status: 'fail',
          detail: 'isConnected() = false',
        };
  } catch (e) {
    return {
      name: `channel:${ch.name}`,
      status: 'fail',
      detail: (e as Error).message,
    };
  }
}

async function checkVoiceBridge(url: string): Promise<HealthCheckResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok
      ? { name: 'voice-bridge', status: 'ok' }
      : {
          name: 'voice-bridge',
          status: 'fail',
          detail: `HTTP ${res.status}`,
        };
  } catch (e) {
    return {
      name: 'voice-bridge',
      status: 'fail',
      detail: (e as Error).message,
    };
  }
}

async function checkOneCli(
  ep: { host: string; port: number },
): Promise<HealthCheckResult> {
  return new Promise<HealthCheckResult>((resolve) => {
    const sock = connect({ host: ep.host, port: ep.port, timeout: DEFAULT_TIMEOUT_MS });
    const done = (r: HealthCheckResult): void => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    sock.once('connect', () => done({ name: 'onecli-gateway', status: 'ok' }));
    sock.once('error', (e) =>
      done({
        name: 'onecli-gateway',
        status: 'fail',
        detail: (e as Error).message,
      }),
    );
    sock.once('timeout', () =>
      done({
        name: 'onecli-gateway',
        status: 'fail',
        detail: `connect timeout after ${DEFAULT_TIMEOUT_MS}ms`,
      }),
    );
  });
}

async function checkSipgate(
  auth: { tokenId: string; token: string } | undefined,
): Promise<HealthCheckResult> {
  const tokenId = auth?.tokenId ?? process.env.SIPGATE_TOKEN_ID;
  const token = auth?.token ?? process.env.SIPGATE_TOKEN;
  if (!tokenId || !token) {
    return { name: 'sipgate', status: 'warn', detail: 'no SIPGATE_TOKEN_ID/SIPGATE_TOKEN configured' };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    const auth = Buffer.from(`${tokenId}:${token}`).toString('base64');
    const res = await fetch('https://api.sipgate.com/v2/account', {
      headers: { authorization: `Basic ${auth}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok
      ? { name: 'sipgate', status: 'ok' }
      : { name: 'sipgate', status: 'fail', detail: `HTTP ${res.status}` };
  } catch (e) {
    return { name: 'sipgate', status: 'fail', detail: (e as Error).message };
  }
}

/**
 * Read an OAuth token file and report its access_token expiry. The file
 * path can either be flat (Gmail credentials.json) or have a `default`
 * envelope (Calendar tokens.json).
 */
async function checkOAuthExpiry(
  name: string,
  path: string,
  now: number,
): Promise<HealthCheckResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (e) {
    return {
      name,
      status: 'fail',
      detail: `read ${path}: ${(e as Error).message}`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return { name, status: 'fail', detail: `invalid JSON: ${(e as Error).message}` };
  }
  const tokens =
    typeof parsed.default === 'object' && parsed.default !== null
      ? (parsed.default as Record<string, unknown>)
      : parsed;
  const accessExpiry = tokens.expiry_date;
  const refreshTtlField = tokens.refresh_token_expires_in;
  const refreshToken = tokens.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return {
      name,
      status: 'fail',
      detail: 'no refresh_token in file — re-auth required',
    };
  }
  // refresh_token_expires_in is the TTL at issuance. For Testing-mode OAuth
  // apps Google sets this to ~7 days. We can't know exact issuance time,
  // but we use file mtime as a proxy: if (mtime + ttl) - now < 24h, warn.
  if (typeof refreshTtlField === 'number' && refreshTtlField > 0) {
    try {
      const stat = await fs.stat(path);
      const mtimeMs = stat.mtimeMs;
      const refreshExpiresAtMs = mtimeMs + refreshTtlField * 1000;
      const remainingMs = refreshExpiresAtMs - now;
      if (remainingMs <= 0) {
        return {
          name,
          status: 'fail',
          detail: `refresh_token expired (Testing-mode 7-day TTL) — re-auth required`,
        };
      }
      if (remainingMs < 24 * 60 * 60 * 1000) {
        const hours = Math.round(remainingMs / (60 * 60 * 1000));
        return {
          name,
          status: 'warn',
          detail: `refresh_token expires in ~${hours}h (Testing-mode 7-day TTL) — re-auth soon`,
        };
      }
    } catch {
      /* mtime check is best-effort */
    }
  }
  if (typeof accessExpiry === 'number') {
    if (accessExpiry <= now) {
      // access expired but refresh_token may still mint a new one — that's
      // ok; warn-level so Carsten knows the next call will trigger refresh.
      return {
        name,
        status: 'ok',
        detail: 'access_token expired (auto-refresh on next use)',
      };
    }
  }
  return { name, status: 'ok' };
}

async function checkContainerImage(image: string): Promise<HealthCheckResult> {
  if (!image) return { name: 'container-image', status: 'warn', detail: 'no image configured' };
  return new Promise<HealthCheckResult>((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(
        'docker',
        ['image', 'inspect', image],
        { timeout: DEFAULT_TIMEOUT_MS },
        (err) => {
          if (err) {
            resolve({
              name: 'container-image',
              status: 'fail',
              detail: `image '${image}' not found locally`,
            });
          } else {
            resolve({ name: 'container-image', status: 'ok' });
          }
        },
      );
    });
  });
}

/**
 * Run all checks in parallel and return the array of results in stable
 * order (channels first, then voice-bridge, then external services).
 */
export async function collectHealthChecks(
  deps: HealthCheckDeps,
): Promise<HealthCheckResult[]> {
  const now = (deps.now ?? (() => Date.now()))();
  const home = homedir();
  const gmailPath = deps.gmailTokenPath ?? join(home, '.gmail-mcp', 'credentials.json');
  const calPath =
    deps.calendarTokenPath ??
    join(home, '.gcalendar-mcp', 'google-calendar-mcp', 'tokens.json');
  const voiceUrl = deps.voiceBridgeHealthUrl ?? DEFAULT_VOICE_BRIDGE_HEALTH;
  const oneCli = deps.oneCliEndpoint ?? DEFAULT_ONECLI;
  const image = deps.containerImage ?? process.env.CONTAINER_IMAGE ?? '';

  const channelChecks = deps.channels.map((c) => checkChannel(c));
  const others: Promise<HealthCheckResult>[] = [
    checkVoiceBridge(voiceUrl),
    checkOneCli(oneCli),
    checkSipgate(deps.sipgateAuth),
    checkOAuthExpiry('oauth:gmail', gmailPath, now),
    checkOAuthExpiry('oauth:calendar', calPath, now),
  ];
  if (image) others.push(checkContainerImage(image));

  return Promise.all([...channelChecks, ...others]);
}

/**
 * Format the results as a short Discord message. All-ok produces a single
 * checkmark line; any non-ok lists each problem with status + detail.
 */
export function formatHealthDigest(
  results: HealthCheckResult[],
  now: Date = new Date(),
): string {
  const fails = results.filter((r) => r.status === 'fail');
  const warns = results.filter((r) => r.status === 'warn');
  const ts = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  if (fails.length === 0 && warns.length === 0) {
    return `✅ Andy systems healthy — ${results.length} checks passed (${ts})`;
  }
  const lines: string[] = [];
  if (fails.length > 0) {
    lines.push(`❌ Andy system check FAILED (${ts})`);
    for (const r of fails) {
      lines.push(`  • ${r.name}: ${r.detail ?? 'fail'}`);
    }
  } else {
    lines.push(`⚠️ Andy system check — warnings (${ts})`);
  }
  if (warns.length > 0) {
    lines.push(fails.length > 0 ? '\nWarnings:' : 'Warnings:');
    for (const r of warns) {
      lines.push(`  • ${r.name}: ${r.detail ?? 'warn'}`);
    }
  }
  const okCount = results.length - fails.length - warns.length;
  lines.push(`\n${okCount} ok / ${warns.length} warn / ${fails.length} fail`);
  return lines.join('\n');
}

/**
 * Phase4 cron entry-point. Collects + posts; never throws.
 */
export async function runHealthCheck(deps: HealthCheckDeps): Promise<void> {
  try {
    const results = await collectHealthChecks(deps);
    const digest = formatHealthDigest(results);
    await deps.sendDiscordAlert(digest);
  } catch (e) {
    // Best-effort: even our own check function shouldn't crash the cron
    // poller. Surface the failure as an alert so Carsten still notices.
    try {
      await deps.sendDiscordAlert(
        `❌ Andy health-check itself crashed: ${(e as Error).message}`,
      );
    } catch {
      /* ignore */
    }
  }
}
