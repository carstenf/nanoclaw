import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeVoiceRequestOutboundCall } from './voice-request-outbound-call.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VALID_ARGS = {
  target_phone: '+491234567890',
  goal: 'Termin beim Arzt vereinbaren',
  context: 'Carsten braucht einen Termin fuer Montag',
  report_to_jid: 'dc:1490365616518070407',
};

const BRIDGE_RESPONSE = {
  outbound_task_id: 'uuid-test-1234',
  estimated_start_ts: new Date().toISOString(),
  queue_position: 0,
  status: 'queued',
};

function makeOkFetch(body = BRIDGE_RESPONSE, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function makeErrorFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
  });
}

describe('voice_request_outbound_call', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'outbound-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: valid args → bridge POST → 200 → ok:true result', async () => {
    const mockFetch = makeOkFetch();
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: mockFetch,
      jsonlPath: join(tmpDir, 'out.jsonl'),
    });
    const result = (await handler(VALID_ARGS)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const res = result.result as Record<string, unknown>;
    expect(res.queued).toBe(true);
    expect(res.outbound_task_id).toBe(BRIDGE_RESPONSE.outbound_task_id);
    expect(res.estimated_start_ts).toBeDefined();
    // Verify POST was made to correct URL
    expect(mockFetch).toHaveBeenCalledWith(
      'http://10.0.0.2:4402/outbound',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('zod: rejects invalid E164 phone number', async () => {
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeOkFetch(),
    });
    await expect(
      handler({ ...VALID_ARGS, target_phone: '0891234567' }),
    ).rejects.toThrow(BadRequestError);
  });

  it('zod: rejects empty goal', async () => {
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeOkFetch(),
    });
    await expect(handler({ ...VALID_ARGS, goal: '' })).rejects.toThrow(
      BadRequestError,
    );
  });

  it('bridge-400: maps to bad_request error response', async () => {
    const mockFetch = makeErrorFetch(400, {
      error: 'bad_request',
      field: 'target_phone',
      message: 'invalid',
    });
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: mockFetch,
      jsonlPath: join(tmpDir, 'out.jsonl'),
    });
    const result = (await handler(VALID_ARGS)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bad_request');
  });

  it('bridge-429: maps to queue_full error response', async () => {
    const mockFetch = makeErrorFetch(429, { error: 'queue_full' });
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: mockFetch,
      jsonlPath: join(tmpDir, 'out.jsonl'),
    });
    const result = (await handler(VALID_ARGS)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('queue_full');
  });

  it('timeout: AbortError maps to tool_unavailable', async () => {
    const abortFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      }),
    );
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: abortFetch,
      timeoutMs: 100,
      jsonlPath: join(tmpDir, 'out.jsonl'),
    });
    const result = (await handler(VALID_ARGS)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('tool_unavailable');
  });

  it('network error: connection refused maps to tool_unavailable', async () => {
    const networkFetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: networkFetch,
      jsonlPath: join(tmpDir, 'out.jsonl'),
    });
    const result = (await handler(VALID_ARGS)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('tool_unavailable');
  });

  it('JSONL: writes PII-clean log entry (no full phone, no goal text)', async () => {
    const mockFetch = makeOkFetch();
    const jsonlPath = join(tmpDir, 'out.jsonl');
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: mockFetch,
      jsonlPath,
    });
    await handler(VALID_ARGS);
    const line = readFileSync(jsonlPath, 'utf8').trim();
    const entry = JSON.parse(line);
    expect(entry.event).toBe('outbound_call_requested');
    // PII checks: no full phone
    expect(line).not.toContain('+491234567890');
    // Should have hash or masked version
    expect(entry.target_phone_hash).toBeDefined();
    // No goal text in JSONL
    expect(line).not.toContain('Termin beim Arzt');
    // Has goal_len instead
    expect(typeof entry.goal_len).toBe('number');
  });

  it('lang: forwarded to bridge POST when set; omitted when undefined', async () => {
    const mockFetch = makeOkFetch();
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: mockFetch,
      jsonlPath: join(tmpDir, 'out.jsonl'),
    });
    await handler({ ...VALID_ARGS, lang: 'it' });
    const callArgs = mockFetch.mock.calls[0][1] as { body: string };
    const body = JSON.parse(callArgs.body) as Record<string, unknown>;
    expect(body.lang).toBe('it');

    mockFetch.mockClear();
    await handler({ ...VALID_ARGS });
    const callArgs2 = mockFetch.mock.calls[0][1] as { body: string };
    const body2 = JSON.parse(callArgs2.body) as Record<string, unknown>;
    expect('lang' in body2).toBe(false);
  });

  it('zod: rejects unsupported lang', async () => {
    const handler = makeVoiceRequestOutboundCall({
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeOkFetch(),
    });
    await expect(
      handler({ ...VALID_ARGS, lang: 'fr' }),
    ).rejects.toThrow(BadRequestError);
  });
});
