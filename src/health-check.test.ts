// src/health-check.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectHealthChecks,
  formatHealthDigest,
  runHealthCheck,
  type HealthCheckResult,
} from './health-check.js';
import type { Channel } from './types.js';

function fakeChannel(name: string, connected: boolean): Channel {
  return {
    name,
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => connected,
    ownsJid: () => false,
    disconnect: async () => {},
  };
}

async function writeTokenFile(
  path: string,
  body: Record<string, unknown>,
  mtimeAgoMs = 0,
): Promise<void> {
  await fs.writeFile(path, JSON.stringify(body));
  if (mtimeAgoMs > 0) {
    const t = new Date(Date.now() - mtimeAgoMs);
    await fs.utimes(path, t, t);
  }
}

describe('formatHealthDigest', () => {
  it('all ok → green checkmark line', () => {
    const out = formatHealthDigest([
      { name: 'channel:discord', status: 'ok' },
      { name: 'voice-bridge', status: 'ok' },
    ]);
    expect(out).toContain('Andy systems healthy');
    expect(out).toContain('2 checks passed');
  });

  it('one fail → ❌ header + bulleted detail', () => {
    const out = formatHealthDigest([
      { name: 'channel:discord', status: 'ok' },
      { name: 'voice-bridge', status: 'fail', detail: 'connection refused' },
    ]);
    expect(out).toContain('FAILED');
    expect(out).toContain('voice-bridge: connection refused');
    expect(out).toContain('1 ok / 0 warn / 1 fail');
  });

  it('warnings only → ⚠️ header', () => {
    const out = formatHealthDigest([
      { name: 'oauth:gmail', status: 'warn', detail: 'expires in ~3h' },
    ]);
    expect(out).toContain('warnings');
    expect(out).toContain('expires in ~3h');
  });

  it('mix fail + warn lists both', () => {
    const out = formatHealthDigest([
      { name: 'channel:gmail', status: 'fail', detail: 'invalid_grant' },
      { name: 'oauth:calendar', status: 'warn', detail: 'expires in ~12h' },
      { name: 'voice-bridge', status: 'ok' },
    ]);
    expect(out).toContain('FAILED');
    expect(out).toContain('channel:gmail: invalid_grant');
    expect(out).toContain('oauth:calendar: expires in ~12h');
    expect(out).toContain('1 ok / 1 warn / 1 fail');
  });
});

describe('collectHealthChecks — channel checks', () => {
  it('connected channels → ok', async () => {
    const results = await collectHealthChecks({
      channels: [fakeChannel('discord', true), fakeChannel('gmail', true)],
      sendDiscordAlert: async () => {},
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health', // intentionally fail
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: '/dev/null/missing',
      calendarTokenPath: '/dev/null/missing',
    });
    const dc = results.find((r) => r.name === 'channel:discord');
    const gm = results.find((r) => r.name === 'channel:gmail');
    expect(dc?.status).toBe('ok');
    expect(gm?.status).toBe('ok');
  });

  it('disconnected channel → fail', async () => {
    const results = await collectHealthChecks({
      channels: [fakeChannel('discord', false)],
      sendDiscordAlert: async () => {},
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health',
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: '/dev/null/missing',
      calendarTokenPath: '/dev/null/missing',
    });
    const dc = results.find((r) => r.name === 'channel:discord');
    expect(dc?.status).toBe('fail');
    expect(dc?.detail).toContain('isConnected() = false');
  });
});

describe('collectHealthChecks — OAuth expiry', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `nanoclaw-health-test-${Date.now()}-${Math.random()}.json`);
  });

  afterEach(async () => {
    await fs.rm(tmpFile, { force: true });
  });

  it('valid token → ok', async () => {
    await writeTokenFile(tmpFile, {
      access_token: 'a',
      refresh_token: 'r',
      expiry_date: Date.now() + 3600_000,
      // No refresh_token_expires_in → not in Testing mode → ok
    });
    const results = await collectHealthChecks({
      channels: [],
      sendDiscordAlert: async () => {},
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health',
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: tmpFile,
      calendarTokenPath: '/dev/null/missing',
    });
    const r = results.find((r) => r.name === 'oauth:gmail');
    expect(r?.status).toBe('ok');
  });

  it('Testing-mode refresh expiring <24h → warn', async () => {
    // mtime = 6 days, 23 hours ago → ~1h until refresh expires
    const sixDaysAndAlmostOne = (6 * 24 + 23) * 60 * 60 * 1000;
    await writeTokenFile(
      tmpFile,
      {
        access_token: 'a',
        refresh_token: 'r',
        refresh_token_expires_in: 7 * 24 * 60 * 60, // 7 days
        expiry_date: Date.now() - 1, // access already expired (separate concern)
      },
      sixDaysAndAlmostOne,
    );
    const results = await collectHealthChecks({
      channels: [],
      sendDiscordAlert: async () => {},
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health',
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: tmpFile,
      calendarTokenPath: '/dev/null/missing',
    });
    const r = results.find((r) => r.name === 'oauth:gmail');
    expect(r?.status).toBe('warn');
    expect(r?.detail).toMatch(/expires in/);
  });

  it('Testing-mode refresh expired → fail', async () => {
    // mtime = 8 days ago → already expired
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    await writeTokenFile(
      tmpFile,
      {
        access_token: 'a',
        refresh_token: 'r',
        refresh_token_expires_in: 7 * 24 * 60 * 60,
        expiry_date: Date.now() - 1,
      },
      eightDays,
    );
    const results = await collectHealthChecks({
      channels: [],
      sendDiscordAlert: async () => {},
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health',
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: tmpFile,
      calendarTokenPath: '/dev/null/missing',
    });
    const r = results.find((r) => r.name === 'oauth:gmail');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toMatch(/expired/);
  });

  it('missing refresh_token → fail', async () => {
    await writeTokenFile(tmpFile, { access_token: 'a' });
    const results = await collectHealthChecks({
      channels: [],
      sendDiscordAlert: async () => {},
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health',
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: tmpFile,
      calendarTokenPath: '/dev/null/missing',
    });
    const r = results.find((r) => r.name === 'oauth:gmail');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toMatch(/no refresh_token/);
  });

  it('Calendar nested under "default" → reads correctly', async () => {
    await writeTokenFile(tmpFile, {
      default: {
        access_token: 'a',
        refresh_token: 'r',
        expiry_date: Date.now() + 3600_000,
      },
    });
    const results = await collectHealthChecks({
      channels: [],
      sendDiscordAlert: async () => {},
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health',
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: '/dev/null/missing',
      calendarTokenPath: tmpFile,
    });
    const r = results.find((r) => r.name === 'oauth:calendar');
    expect(r?.status).toBe('ok');
  });

  it('missing file → fail', async () => {
    const results = await collectHealthChecks({
      channels: [],
      sendDiscordAlert: async () => {},
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health',
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: '/dev/null/definitely-does-not-exist',
      calendarTokenPath: '/dev/null/missing',
    });
    const r = results.find((r) => r.name === 'oauth:gmail');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toMatch(/read /);
  });
});

describe('runHealthCheck', () => {
  it('posts digest via sendDiscordAlert', async () => {
    const sent: string[] = [];
    await runHealthCheck({
      channels: [fakeChannel('discord', true)],
      sendDiscordAlert: async (m) => {
        sent.push(m);
      },
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health', // will fail
      oneCliEndpoint: { host: '127.0.0.1', port: 1 }, // will fail
      gmailTokenPath: '/dev/null/missing',
      calendarTokenPath: '/dev/null/missing',
    });
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatch(/Andy/);
  });

  it('never throws even if collectHealthChecks does', async () => {
    const sent: string[] = [];
    await runHealthCheck({
      channels: [
        // Channel whose isConnected() throws — shouldn't crash the run
        {
          name: 'broken',
          connect: async () => {},
          sendMessage: async () => {},
          isConnected: () => {
            throw new Error('boom');
          },
          ownsJid: () => false,
          disconnect: async () => {},
        },
      ],
      sendDiscordAlert: async (m) => {
        sent.push(m);
      },
      voiceBridgeHealthUrl: 'http://127.0.0.1:1/health',
      oneCliEndpoint: { host: '127.0.0.1', port: 1 },
      gmailTokenPath: '/dev/null/missing',
      calendarTokenPath: '/dev/null/missing',
    });
    expect(sent.length).toBe(1);
    // The broken channel surfaces as fail — runHealthCheck does NOT crash.
    expect(sent[0]).toMatch(/Andy/);
  });
});
