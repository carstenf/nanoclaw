// src/mcp-tools/voice-set-language.test.ts
//
// Phase 06.x — voice_set_language unit tests.
// Renderer is real (deterministic), gateway state is the production module
// (reset between tests). No network, no fs side-effects beyond the
// voice-personas i18n folder.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeVoiceSetLanguage } from './voice-set-language.js';
import {
  registerActiveCall,
  deregisterActiveCall,
  getActiveLang,
  _resetActiveSet,
} from '../voice-mid-call-gateway.js';
import { BadRequestError } from './voice-on-transcript-turn.js';

const RENDER_CTX_FIXTURE = {
  case_type: 'case_2' as const,
  call_direction: 'outbound' as const,
  counterpart_label: 'Tante Anke',
  goal: 'Sag Tante Anke kurz hallo.',
};

beforeEach(() => {
  _resetActiveSet();
});

describe('voice_set_language', () => {
  it('happy path: lang in whitelist → re-renders persona, returns instructions+lang', async () => {
    registerActiveCall('rtc_test_1', {
      lang: 'de',
      lang_whitelist: ['de', 'en', 'it'],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    const handler = makeVoiceSetLanguage();
    const r = (await handler({ call_id: 'rtc_test_1', lang: 'en' })) as {
      ok: boolean;
      result: { instructions: string; lang: string };
    };
    expect(r.ok).toBe(true);
    expect(r.result.lang).toBe('en');
    expect(r.result.instructions.length).toBeGreaterThan(100);
    // English baseline content present:
    expect(r.result.instructions).toContain('NanoClaw');
    expect(r.result.instructions.toLowerCase()).toContain('english');
    // Active lang in gateway updated:
    expect(getActiveLang('rtc_test_1')).toBe('en');
  });

  it('off-whitelist lang → returns error lang_not_in_whitelist; gateway state unchanged', async () => {
    registerActiveCall('rtc_test_2', {
      lang: 'de',
      lang_whitelist: ['de', 'en'],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    const handler = makeVoiceSetLanguage();
    const r = (await handler({ call_id: 'rtc_test_2', lang: 'it' })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('lang_not_in_whitelist');
    // Gateway active lang unchanged:
    expect(getActiveLang('rtc_test_2')).toBe('de');
  });

  it('unknown call_id → returns call_unknown', async () => {
    const handler = makeVoiceSetLanguage();
    const r = (await handler({ call_id: 'rtc_doesnt_exist', lang: 'en' })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('call_unknown');
  });

  it('empty whitelist (single-lang call) → any switch attempt blocked', async () => {
    registerActiveCall('rtc_test_3', {
      lang: 'de',
      lang_whitelist: [],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    const handler = makeVoiceSetLanguage();
    const r = (await handler({ call_id: 'rtc_test_3', lang: 'en' })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('lang_not_in_whitelist');
  });

  it('zod: rejects unsupported lang', async () => {
    const handler = makeVoiceSetLanguage();
    await expect(
      handler({ call_id: 'rtc_x', lang: 'fr' }),
    ).rejects.toThrow(BadRequestError);
  });

  it('zod: rejects missing call_id', async () => {
    const handler = makeVoiceSetLanguage();
    await expect(handler({ lang: 'en' })).rejects.toThrow(BadRequestError);
  });

  it('skill load failure → render_failed; gateway state unchanged', async () => {
    registerActiveCall('rtc_test_5', {
      lang: 'de',
      lang_whitelist: ['de', 'en'],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    const handler = makeVoiceSetLanguage({
      loadSkillFiles: () => {
        throw new Error('ENOENT skill missing');
      },
    });
    const r = (await handler({ call_id: 'rtc_test_5', lang: 'en' })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('render_failed');
    expect(getActiveLang('rtc_test_5')).toBe('de'); // unchanged
  });

  it('switching back to starting lang is allowed (whitelist must include starter)', async () => {
    registerActiveCall('rtc_test_6', {
      lang: 'de',
      lang_whitelist: ['de', 'en', 'it'],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    const handler = makeVoiceSetLanguage();
    // First switch to en
    await handler({ call_id: 'rtc_test_6', lang: 'en' });
    expect(getActiveLang('rtc_test_6')).toBe('en');
    // Then back to de
    const r = (await handler({ call_id: 'rtc_test_6', lang: 'de' })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(true);
    expect(getActiveLang('rtc_test_6')).toBe('de');
  });

  it('mock skill loader: result honours lang in render_ctx', async () => {
    registerActiveCall('rtc_test_7', {
      lang: 'de',
      lang_whitelist: ['de', 'it'],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    const fakeLoad = vi.fn().mockReturnValue({
      skill: '#fake',
      baseline: 'Lingua: italiano. {{lang_switch_block}}\nGoal: {{goal}}',
      overlay: '',
      overlayPath: null,
    });
    const handler = makeVoiceSetLanguage({ loadSkillFiles: fakeLoad });
    const r = (await handler({ call_id: 'rtc_test_7', lang: 'it' })) as {
      ok: boolean;
      result: { instructions: string };
    };
    expect(r.ok).toBe(true);
    // Loader was called with new lang:
    expect(fakeLoad).toHaveBeenCalledWith('case_2', 'it');
    // Goal-text from render_ctx still present:
    expect(r.result.instructions).toContain('Sag Tante Anke kurz hallo.');
  });
});

describe('voice-mid-call-gateway lang state', () => {
  it('registerActiveCall stores lang + whitelist; getters return them', async () => {
    registerActiveCall('rtc_g1', {
      lang: 'en',
      lang_whitelist: ['de', 'en'],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    const { getActiveLang, getActiveWhitelist, getActiveRenderCtx } =
      await import('../voice-mid-call-gateway.js');
    expect(getActiveLang('rtc_g1')).toBe('en');
    expect(getActiveWhitelist('rtc_g1')).toEqual(['de', 'en']);
    expect(getActiveRenderCtx('rtc_g1')?.case_type).toBe('case_2');
  });

  it('deregisterActiveCall removes the entry; getters return null', async () => {
    registerActiveCall('rtc_g2', {
      lang: 'de',
      lang_whitelist: [],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    deregisterActiveCall('rtc_g2');
    const { getActiveLang, getActiveWhitelist } = await import(
      '../voice-mid-call-gateway.js'
    );
    expect(getActiveLang('rtc_g2')).toBeNull();
    expect(getActiveWhitelist('rtc_g2')).toBeNull();
  });

  it('default register (no opts) → lang=de, whitelist=[]', async () => {
    registerActiveCall('rtc_g3');
    const { getActiveLang, getActiveWhitelist } = await import(
      '../voice-mid-call-gateway.js'
    );
    expect(getActiveLang('rtc_g3')).toBe('de');
    expect(getActiveWhitelist('rtc_g3')).toEqual([]);
  });

  it('setActiveLang on unknown call → false; on known call → true and updates state', async () => {
    const { setActiveLang } = await import('../voice-mid-call-gateway.js');
    expect(setActiveLang('rtc_unknown', 'en')).toBe(false);

    registerActiveCall('rtc_g4', {
      lang: 'de',
      lang_whitelist: ['de', 'en'],
      render_ctx: RENDER_CTX_FIXTURE,
    });
    expect(setActiveLang('rtc_g4', 'en')).toBe(true);
    expect(getActiveLang('rtc_g4')).toBe('en');
  });
});
