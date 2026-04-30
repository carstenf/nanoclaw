// src/mcp-tools/voice-set-operator-config.test.ts
//
// v1.4.0 — voice_set_operator_config unit tests. Uses a stub writer so no
// fs side-effects leak between tests.

import { describe, expect, it, vi } from 'vitest';

import { makeVoiceSetOperatorConfig } from './voice-set-operator-config.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import type { VoiceConfig } from '../voice-config.js';

function makeHandler(initial: VoiceConfig = {}) {
  let stored: VoiceConfig = { ...initial };
  const write = vi.fn((partial: Partial<VoiceConfig>): VoiceConfig => {
    for (const [k, v] of Object.entries(partial)) {
      const key = k as keyof VoiceConfig;
      if (v === undefined || v === '') delete stored[key];
      else stored[key] = v as string;
    }
    return { ...stored };
  });
  const handler = makeVoiceSetOperatorConfig({ write });
  return { handler, write, getStored: () => stored };
}

describe('voice_set_operator_config', () => {
  it('writes operator_name only', async () => {
    const { handler, write, getStored } = makeHandler();
    const r = (await handler({ operator_name: 'Carsten' })) as {
      ok: true;
      result: { config: VoiceConfig };
    };
    expect(r.ok).toBe(true);
    expect(r.result.config).toEqual({ operator_name: 'Carsten' });
    expect(write).toHaveBeenCalledWith({ operator_name: 'Carsten' });
    expect(getStored().operator_name).toBe('Carsten');
  });

  it('writes operator_cli_number only', async () => {
    const { handler, write } = makeHandler();
    const r = (await handler({ operator_cli_number: '+491701234567' })) as {
      ok: true;
      result: { config: VoiceConfig };
    };
    expect(r.ok).toBe(true);
    expect(r.result.config.operator_cli_number).toBe('+491701234567');
    expect(write).toHaveBeenCalledWith({ operator_cli_number: '+491701234567' });
  });

  it('writes both fields at once', async () => {
    const { handler } = makeHandler();
    const r = (await handler({
      operator_name: 'Carsten',
      operator_cli_number: '+491701234567',
    })) as { ok: true; result: { config: VoiceConfig } };
    expect(r.result.config).toEqual({
      operator_name: 'Carsten',
      operator_cli_number: '+491701234567',
    });
  });

  it('merges with existing values (does not clobber unrelated keys)', async () => {
    const { handler, getStored } = makeHandler({
      operator_name: 'Old',
      operator_cli_number: '+491701234567',
    });
    await handler({ operator_name: 'New' });
    expect(getStored()).toEqual({
      operator_name: 'New',
      operator_cli_number: '+491701234567',
    });
  });

  it('trims whitespace from inputs', async () => {
    const { handler, write } = makeHandler();
    await handler({ operator_name: '  Carsten  ' });
    expect(write).toHaveBeenCalledWith({ operator_name: 'Carsten' });
  });

  it('rejects when both fields missing', async () => {
    const { handler } = makeHandler();
    await expect(handler({})).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects malformed E.164 (leading 0)', async () => {
    const { handler } = makeHandler();
    await expect(handler({ operator_cli_number: '0170123456' })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it('rejects E.164 with spaces', async () => {
    const { handler } = makeHandler();
    await expect(handler({ operator_cli_number: '+49 170 1234567' })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it('rejects empty operator_name', async () => {
    const { handler } = makeHandler();
    await expect(handler({ operator_name: '' })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('returns write_failed when the writer throws', async () => {
    const write = vi.fn(() => {
      throw new Error('disk full');
    });
    const handler = makeVoiceSetOperatorConfig({ write });
    const r = (await handler({ operator_name: 'Carsten' })) as {
      ok: false;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('write_failed');
  });
});
