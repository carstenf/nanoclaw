import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  BadRequestError,
  makeVoiceOnTranscriptTurn,
  validateVoiceTurnArgs,
} from './voice-on-transcript-turn.js';
import {
  ToolRegistry,
  UnknownToolError,
  buildDefaultRegistry,
} from './index.js';
import { SlowBrainSessionManager } from './slow-brain-session.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: create a SlowBrainSessionManager that always returns a fixed value
function makeSessionManager(
  returnValue: string | null,
): SlowBrainSessionManager {
  const claudeClient = vi
    .fn()
    .mockResolvedValue(returnValue === null ? 'null' : returnValue);
  return new SlowBrainSessionManager({ claudeClient });
}

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
  it('returns {ok:true, instructions_update:null} when no session manager (stub compat)', async () => {
    // Without a sessionManager, handler falls back to null (stub behavior)
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
    const firstLine = jsonl.trim().split('\n')[0];
    const line = JSON.parse(firstLine);
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

  it('uses sessionManager and returns instructions_update from Claude', async () => {
    const sessionManager = makeSessionManager('Bitte freundlicher antworten.');
    const handler = makeVoiceOnTranscriptTurn({
      dataDir: tmpDir,
      sessionManager,
    });
    const out = await handler({
      call_id: 'call-sm-1',
      turn_id: 'turn-1',
      transcript: 'Guten Morgen',
    });
    expect(out).toEqual({
      ok: true,
      instructions_update: 'Bitte freundlicher antworten.',
    });
  });

  it('returns instructions_update:null when Claude says null', async () => {
    const sessionManager = makeSessionManager(null);
    const handler = makeVoiceOnTranscriptTurn({
      dataDir: tmpDir,
      sessionManager,
    });
    const out = await handler({
      call_id: 'call-sm-2',
      turn_id: 'turn-1',
      transcript: 'Hallo',
    });
    expect(out).toEqual({ ok: true, instructions_update: null });
  });

  it('writes slow_brain_inference_done JSONL event with metrics (no PII)', async () => {
    const sessionManager = makeSessionManager('Update: sei freundlicher!');
    const handler = makeVoiceOnTranscriptTurn({
      dataDir: tmpDir,
      now: () => 1700000001000,
      sessionManager,
    });
    await handler({
      call_id: 'call-sm-3',
      turn_id: 'turn-2',
      transcript: 'Wie heisst du?',
    });

    const jsonl = fs.readFileSync(
      path.join(tmpDir, 'voice-slow-brain.jsonl'),
      'utf-8',
    );
    const lines = jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const inferenceEvent = lines.find(
      (l) => l.event === 'slow_brain_inference_done',
    );
    expect(inferenceEvent).toBeDefined();
    expect(inferenceEvent.turn_id).toBe('turn-2');
    expect(typeof inferenceEvent.claude_latency_ms).toBe('number');
    expect(typeof inferenceEvent.instructions_update_len).toBe('number');
    expect(inferenceEvent.message_count).toBeGreaterThan(0);
    // Must NOT contain the actual transcript or instructions text
    expect(JSON.stringify(inferenceEvent)).not.toContain('Wie heisst du');
    expect(JSON.stringify(inferenceEvent)).not.toContain('sei freundlicher');
  });

  it('returns null and logs warn when sessionManager throws', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const failingClient = vi
      .fn()
      .mockRejectedValue(new Error('Claude offline'));
    const sessionManager = new SlowBrainSessionManager({
      claudeClient: failingClient,
    });
    const handler = makeVoiceOnTranscriptTurn({
      dataDir: tmpDir,
      sessionManager,
      log,
    });
    const out = await handler({
      call_id: 'call-err',
      turn_id: 'turn-err',
      transcript: 'test',
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
    // Inject a no-op session manager to avoid real OneCLI calls in tests
    const mockSessionManager = makeSessionManager(null);
    const registry = buildDefaultRegistry({
      dataDir: tmpDir,
      sessionManager: mockSessionManager,
      sweepIntervalMs: 0,
    });
    expect(registry.has('voice.on_transcript_turn')).toBe(true);
    const out = await registry.invoke('voice.on_transcript_turn', {
      call_id: 'c',
      turn_id: 't',
      transcript: 'hi',
    });
    expect(out).toEqual({ ok: true, instructions_update: null });
  });
});
