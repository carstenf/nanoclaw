import type { Request, Response, NextFunction } from 'express';

import { logger } from './logger.js';

type Log = Pick<typeof logger, 'warn'>;

export function normalizePeerIp(raw: string | undefined): string {
  if (!raw) return '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * Phase 05.4 Bug-2 follow-up: CIDR subnet match for allowlist entries like
 * `172.17.0.0/16`. Needed so the Docker-bridge connection from the NanoClaw
 * container-agent to the nanoclaw-voice MCP stream server is allowed —
 * container IPs are dynamic (172.17.0.2, .3, ...) so an exact-IP allowlist
 * cannot cover them. Only IPv4. Invalid entries reject.
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const byte = Number(p);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    n = (n * 256) + byte;
  }
  return n;
}

function peerMatchesEntry(peer: string, entry: string): boolean {
  if (entry === peer) return true;
  const slash = entry.indexOf('/');
  if (slash === -1) return false;
  const network = entry.slice(0, slash);
  const bits = Number(entry.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const peerInt = ipv4ToInt(peer);
  const netInt = ipv4ToInt(network);
  if (peerInt === null || netInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (peerInt & mask) === (netInt & mask);
}

export function peerAllowlistMiddleware(
  allowlist: string[],
  log: Log = logger,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const peer = normalizePeerIp(req.socket.remoteAddress);
    const allowed =
      allowlist.length > 0 && allowlist.some((e) => peerMatchesEntry(peer, e));
    if (!allowed) {
      log.warn(
        { event: 'mcp_peer_blocked', peer_ip: peer },
        'MCP peer blocked by allowlist',
      );
      res.status(403).json({ error: 'peer_not_allowed', peer_ip: peer });
      return;
    }
    next();
  };
}
