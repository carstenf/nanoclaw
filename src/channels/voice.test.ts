/**
 * Voice adapter tests.
 *
 * Covers the four pieces that aren't naturally exercised by integration
 * tests: outbound text extraction, MCP raw client, Discord fanout target
 * lookup, and deliver()'s contract that voice_post_answer fires regardless
 * of fanout outcome.
 *
 * The long-poll loop is not unit-tested — its scheduling, abort handling,
 * and reconnect backoff are best exercised by the smoke-test against a
 * live voice-mcp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-voice' };
});

import fs from 'fs';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup, createMessagingGroup, createMessagingGroupAgent } from '../db/index.js';
import { __voiceTestables, VOICE_CHANNEL_TYPE, VOICE_PLATFORM_ID } from './voice.js';

const { callMcpTool, extractTextFromOutbound, pickDiscordFanoutTarget, VoiceAdapter } = __voiceTestables;

const TEST_DIR = '/tmp/nanoclaw-test-voice';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndVoiceMg(opts: { withDiscord: boolean }): void {
  createAgentGroup({
    id: 'ag-voice',
    name: 'Andy',
    folder: 'andy',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-voice',
    channel_type: VOICE_CHANNEL_TYPE,
    platform_id: VOICE_PLATFORM_ID,
    name: 'voice',
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-voice',
    messaging_group_id: 'mg-voice',
    agent_group_id: 'ag-voice',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
  if (opts.withDiscord) {
    createMessagingGroup({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'discord:guild:channel',
      name: 'Andy DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-discord',
      messaging_group_id: 'mg-discord',
      agent_group_id: 'ag-voice',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 5,
      created_at: now(),
    });
  }
}

describe('extractTextFromOutbound', () => {
  it('reads markdown field', () => {
    expect(extractTextFromOutbound({ kind: 'message', content: { markdown: 'hi' } })).toBe('hi');
  });
  it('falls back to text field', () => {
    expect(extractTextFromOutbound({ kind: 'message', content: { text: 'hi' } })).toBe('hi');
  });
  it('prefers markdown over text', () => {
    expect(
      extractTextFromOutbound({
        kind: 'message',
        content: { markdown: 'md', text: 'tx' },
      }),
    ).toBe('md');
  });
  it('returns null for empty content', () => {
    expect(extractTextFromOutbound({ kind: 'message', content: {} })).toBeNull();
  });
  it('returns null for null content', () => {
    expect(extractTextFromOutbound({ kind: 'message', content: null })).toBeNull();
  });
  it('returns null for non-renderable kind (cards, ask_question)', () => {
    expect(
      extractTextFromOutbound({
        kind: 'message',
        content: { type: 'ask_question', title: 'Pick' },
      }),
    ).toBeNull();
  });
  it('accepts string content', () => {
    expect(extractTextFromOutbound({ kind: 'message', content: 'plain' })).toBe('plain');
  });
});

describe('callMcpTool', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses SSE-shaped response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"result\\":{\\"empty\\":true}}"}]}}\n\n',
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const r = await callMcpTool('http://x/', 'b', 'voice_wait_for_question', {});
    expect(r).toEqual({ ok: true, result: { empty: true } });
  });

  it('parses JSON-shaped response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"result\\":{\\"delivered\\":true}}"}]}}',
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const r = await callMcpTool('http://x/', 'b', 'voice_post_answer', {});
    expect(r).toEqual({ ok: true, result: { delivered: true } });
  });

  it('returns null on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    expect(await callMcpTool('http://x/', 'b', 't', {})).toBeNull();
  });

  it('returns null on fetch failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('econn');
    }) as unknown as typeof fetch;
    expect(await callMcpTool('http://x/', 'b', 't', {})).toBeNull();
  });

  it('returns null on bad payload shape', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('event: message\ndata: {"result":{"content":[]}}\n\n', { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await callMcpTool('http://x/', 'b', 't', {})).toBeNull();
  });
});

describe('pickDiscordFanoutTarget', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns Discord MG sharing the voice agent_group', () => {
    seedAgentAndVoiceMg({ withDiscord: true });
    const target = pickDiscordFanoutTarget();
    expect(target).toEqual({ channelType: 'discord', platformId: 'discord:guild:channel' });
  });

  it('returns null when no Discord wiring shares the agent_group', () => {
    seedAgentAndVoiceMg({ withDiscord: false });
    const target = pickDiscordFanoutTarget();
    expect(target).toBeNull();
  });

  it('returns null when the voice MG itself is missing', () => {
    expect(pickDiscordFanoutTarget()).toBeNull();
  });
});

describe('VoiceAdapter.deliver', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('drops outbound when threadId (call_id) is missing', async () => {
    const adapter = new VoiceAdapter('http://x/', 'b');
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await adapter.deliver('default', null, {
      kind: 'message',
      content: { markdown: 'hi' },
    });
    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls voice_post_answer with the extracted text', async () => {
    seedAgentAndVoiceMg({ withDiscord: false });
    const adapter = new VoiceAdapter('http://x/', 'b');
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"result\\":{\\"delivered\\":true}}"}]}}\n\n',
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await adapter.deliver('default', 'call-123', {
      kind: 'message',
      content: { markdown: 'Morgen wird sonnig.' },
    });
    // First call is voice_post_answer; fanout would have been a second call,
    // but withDiscord:false means no fanout target, so fetch is called once.
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0].body);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('voice_post_answer');
    expect(body.params.arguments).toEqual({
      call_id: 'call-123',
      voice_short: 'Morgen wird sonnig.',
      discord_long: null,
    });
  });

  it('does not fail when voice_post_answer fetch errors (logs and returns)', async () => {
    seedAgentAndVoiceMg({ withDiscord: false });
    const adapter = new VoiceAdapter('http://x/', 'b');
    globalThis.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(
      adapter.deliver('default', 'call-1', {
        kind: 'message',
        content: { markdown: 'x' },
      }),
    ).resolves.toBeUndefined();
  });
});
