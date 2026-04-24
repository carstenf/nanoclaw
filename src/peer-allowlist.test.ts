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

  // Phase 05.4 Bug-2 follow-up: CIDR matching for Docker-bridge subnet.
  describe('CIDR support', () => {
    const cidrTests: Array<[string, string, boolean]> = [
      // peer, allowlist entry, expected allow
      ['172.17.0.3', '172.17.0.0/16', true],
      ['172.17.255.254', '172.17.0.0/16', true],
      ['172.18.0.3', '172.17.0.0/16', false],
      ['10.0.0.3', '10.0.0.0/8', true],
      ['11.0.0.3', '10.0.0.0/8', false],
      ['192.168.1.100', '192.168.1.0/24', true],
      ['192.168.2.1', '192.168.1.0/24', false],
      ['1.2.3.4', '0.0.0.0/0', true],
      ['1.2.3.4', '1.2.3.4/32', true],
      ['1.2.3.5', '1.2.3.4/32', false],
    ];
    for (const [peer, entry, expected] of cidrTests) {
      it(`peer ${peer} vs ${entry} → ${expected ? 'allow' : 'block'}`, () => {
        const log = { warn: vi.fn() };
        const mw = peerAllowlistMiddleware([entry], log);
        const req = makeReq(peer);
        const res = makeRes();
        const next = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mw(req as any, res as any, next);
        if (expected) {
          expect(next).toHaveBeenCalled();
          expect(res.statusCode).toBeUndefined();
        } else {
          expect(next).not.toHaveBeenCalled();
          expect(res.statusCode).toBe(403);
        }
      });
    }

    it('mixed allowlist (exact IP + CIDR) allows both forms', () => {
      const log = { warn: vi.fn() };
      const mw = peerAllowlistMiddleware(
        ['10.0.0.2', '172.17.0.0/16'],
        log,
      );
      for (const peer of ['10.0.0.2', '172.17.0.99']) {
        const req = makeReq(peer);
        const res = makeRes();
        const next = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mw(req as any, res as any, next);
        expect(next).toHaveBeenCalled();
      }
    });

    it('malformed CIDR (bad bits) rejects, does not crash', () => {
      const log = { warn: vi.fn() };
      const mw = peerAllowlistMiddleware(['172.17.0.0/64'], log);
      const req = makeReq('172.17.0.3');
      const res = makeRes();
      const next = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mw(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });
  });
});
