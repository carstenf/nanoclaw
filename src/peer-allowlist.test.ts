import { describe, it, expect, vi } from 'vitest';

import { normalizePeerIp, peerAllowlistMiddleware } from './peer-allowlist.js';

function makeReq(remoteAddress: string | undefined): {
  socket: { remoteAddress: string | undefined };
} {
  return { socket: { remoteAddress } };
}

function makeRes(): {
  statusCode?: number;
  body?: unknown;
  status: (c: number) => { json: (b: unknown) => void };
  json: (b: unknown) => void;
} {
  const res: ReturnType<typeof makeRes> = {
    status: (c: number) => {
      res.statusCode = c;
      return {
        json: (b: unknown) => {
          res.body = b;
        },
      };
    },
    json: (b: unknown) => {
      res.body = b;
    },
  };
  return res;
}

describe('normalizePeerIp', () => {
  it('strips ::ffff: IPv6-mapped prefix', () => {
    expect(normalizePeerIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });

  it('passes plain IPv4 through unchanged', () => {
    expect(normalizePeerIp('10.0.0.4')).toBe('10.0.0.4');
  });

  it('handles undefined as empty string', () => {
    expect(normalizePeerIp(undefined)).toBe('');
  });
});

describe('peerAllowlistMiddleware', () => {
  it('allows listed peer — calls next, no warn', () => {
    const log = { warn: vi.fn() };
    const mw = peerAllowlistMiddleware(['10.0.0.1', '10.0.0.4'], log);
    const req = makeReq('10.0.0.1');
    const res = makeRes();
    const next = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw(req as any, res as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(res.statusCode).toBeUndefined();
  });

  it('blocks unlisted peer — 403 peer_not_allowed + warn log', () => {
    const log = { warn: vi.fn() };
    const mw = peerAllowlistMiddleware(['10.0.0.1'], log);
    const req = makeReq('10.0.0.99');
    const res = makeRes();
    const next = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: 'peer_not_allowed',
      peer_ip: '10.0.0.99',
    });
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      event: 'mcp_peer_blocked',
      peer_ip: '10.0.0.99',
    });
  });

  it('normalizes IPv6-mapped peer before allowlist check', () => {
    const log = { warn: vi.fn() };
    const mw = peerAllowlistMiddleware(['10.0.0.4'], log);
    const req = makeReq('::ffff:10.0.0.4');
    const res = makeRes();
    const next = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw(req as any, res as any, next);
    expect(next).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('empty allowlist blocks everyone (fail-safe)', () => {
    const log = { warn: vi.fn() };
    const mw = peerAllowlistMiddleware([], log);
    const req = makeReq('10.0.0.1');
    const res = makeRes();
    const next = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
