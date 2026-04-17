import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  BadRequestError,
  makeVoiceOnTranscriptTurn,
  validateVoiceTurnArgs,
} from './voice-on-transcript-turn.js';
import { ToolRegistry, UnknownToolError, buildDefaultRegistry } from './index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('validateVoiceTurnArgs', () => {
  it('accepts valid payload', () => {
    expect(
      validateVoiceTurnArgs({ call_id: 'c', turn_id: 't', transcript: 'x' }),
    ).toEqual({ call_id: 'c', turn_id: 't', transcript: 'x' });
  });

  it('rejects missing call_id with BadRequestError', () => {
    expect(() =>
      validateVoiceTurnArgs({ turn_id: 't', transcript: 'x' }),
    ).toThrow(BadRequestError);
    try {
      validateVoiceTurnArgs({ turn_id: 't', transcript: 'x' });
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      expect((e as BadRequestError).field).toBe('call_id');
    }
  });

  it('rejects non-string transcript (number)', () => {
    try {
      validateVoiceTurnArgs({ call_id: 'c', turn_id: 't', transcript: 123 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      expect((e as BadRequestError).field).toBe('transcript');
    }
  });

  it('rejects non-object arguments', () => {
    expect(() => validateVoiceTurnArgs(null)).toThrow(BadRequestError);
    expect(() => validateVoiceTurnArgs('foo')).toThrow(BadRequestError);
  });
});

describe('voiceOnTranscriptTurn handler', () => {
  it('returns {ok:true, instructions_update:null} for valid input', async () => {
    const handler = makeVoiceOnTranscriptTurn({ dataDir: tmpDir });
    const out = await handler({
      call_id: 'rtc-1',
      turn_id: 't-0',
      transcript: 'hallo claude',
    });
    expect(out).toEqual({ ok: true, instructions_update: null });
  });

  it('writes a JSONL line with transcript_len (not transcript text)', async () => {
    const handler = makeVoiceOnTranscriptTurn({
      dataDir: tmpDir,
      now: () => 1700000000000,
    });
    await handler({
      call_id: 'rtc-2',
      turn_id: 't-1',
      transcript: 'hallo claude',
    });
    const jsonl = fs.readFileSync(
      path.join(tmpDir, 'voice-slow-brain.jsonl'),
      'utf-8',
    );
    const line = JSON.parse(jsonl.trim());
    expect(line).toMatchObject({
      ts: 1700000000000,
      event: 'transcript_turn_received',
      call_id: 'rtc-2',
      turn_id: 't-1',
      transcript_len: 12,
    });
    expect(line.transcript).toBeUndefined();
    expect(jsonl.includes('hallo claude')).toBe(false);
  });

  it('swallows filesystem errors (no throw to caller)', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const handler = makeVoiceOnTranscriptTurn({
      dataDir: '/nonexistent/readonly/path-that-cannot-be-created\0',
      log,
    });
    const out = await handler({
      call_id: 'c',
      turn_id: 't',
      transcript: 'x',
    });
    expect(out).toEqual({ ok: true, instructions_update: null });
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('ToolRegistry', () => {
  it('invoke throws UnknownToolError for unregistered tool', async () => {
    const registry = new ToolRegistry();
    await expect(registry.invoke('foo.bar', {})).rejects.toThrow(
      UnknownToolError,
    );
  });

  it('buildDefaultRegistry registers voice.on_transcript_turn', async () => {
    const registry = buildDefaultRegistry({ dataDir: tmpDir });
    expect(registry.has('voice.on_transcript_turn')).toBe(true);
    const out = await registry.invoke('voice.on_transcript_turn', {
      call_id: 'c',
      turn_id: 't',
      transcript: 'hi',
    });
    expect(out).toEqual({ ok: true, instructions_update: null });
  });
});
