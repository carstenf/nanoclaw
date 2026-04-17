import type { Request, Response, NextFunction } from 'express';

import { logger } from './logger.js';

type Log = Pick<typeof logger, 'warn'>;

export function normalizePeerIp(raw: string | undefined): string {
  if (!raw) return '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function peerAllowlistMiddleware(
  allowlist: string[],
  log: Log = logger,
) {
  const allowed = new Set(allowlist);
  return (req: Request, res: Response, next: NextFunction): void => {
    const peer = normalizePeerIp(req.socket.remoteAddress);
    if (allowed.size === 0 || !allowed.has(peer)) {
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
