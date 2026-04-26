import { describe, it, expect, vi } from 'vitest';
import { makeVoiceRespond } from './voice-respond.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import { VoiceRespondManager } from '../voice-channel/index.js';

const APOLOGY_PREFIX =
  '(Andy ist langsamer als der Voice-Timeout — Antwort kommt deshalb hier auf Discord) ';

function makeManager(): VoiceRespondManager {
  return new VoiceRespondManager();
}

function makeSendDiscord() {
  return vi
    .fn()
    .mockResolvedValue({ ok: true } as { ok: true } | { ok: false; error: string });
}

describe('voice_respond MCP tool', () => {
  describe('discord-delivery contract', () => {
    it('matched + discord_long: resolves manager, posts discord_long with NO prefix', async () => {
      const manager = makeManager();
      const sendDiscord = makeSendDiscord();
      const handler = makeVoiceRespond({
        manager,
        sendDiscord,
        andyDiscordChannel: 'chan-andy',
      });
      const pending = manager.register('rtc_1', 5000);

      const result = await handler({
        call_id: 'rtc_1',
        voice_short: 'kurz',
        discord_long: 'lang lang lang',
      });

      expect(result).toEqual({
        ok: true,
        result: { matched: true, call_id: 'rtc_1' },
      });
      await expect(pending).resolves.toEqual({
        voice_short: 'kurz',
        discord_long: 'lang lang lang',
      });
      expect(sendDiscord).toHaveBeenCalledOnce();
      expect(sendDiscord).toHaveBeenCalledWith('chan-andy', 'lang lang lang');
    });

    it('matched + no discord_long: resolves manager, NO discord post', async () => {
      const manager = makeManager();
      const sendDiscord = makeSendDiscord();
      const handler = makeVoiceRespond({
        manager,
        sendDiscord,
        andyDiscordChannel: 'chan-andy',
      });
      const pending = manager.register('rtc_2', 5000);

      const result = await handler({ call_id: 'rtc_2', voice_short: 'kurz' });

      expect(result).toEqual({
        ok: true,
        result: { matched: true, call_id: 'rtc_2' },
      });
      await expect(pending).resolves.toEqual({
        voice_short: 'kurz',
        discord_long: null,
      });
      expect(sendDiscord).not.toHaveBeenCalled();
    });

    it('!matched + discord_long: returns matched=false, posts discord_long WITH apology prefix', async () => {
      const manager = makeManager();
      const sendDiscord = makeSendDiscord();
      const handler = makeVoiceRespond({
        manager,
        sendDiscord,
        andyDiscordChannel: 'chan-andy',
      });

      const result = await handler({
        call_id: 'rtc_unknown',
        voice_short: 'kurz',
        discord_long: 'lang',
      });

      expect(result).toEqual({
        ok: true,
        result: { matched: false, call_id: 'rtc_unknown' },
      });
      expect(sendDiscord).toHaveBeenCalledOnce();
      expect(sendDiscord).toHaveBeenCalledWith(
        'chan-andy',
        APOLOGY_PREFIX + 'lang',
      );
    });

    it('!matched + no discord_long: posts voice_short fallback WITH apology prefix', async () => {
      const manager = makeManager();
      const sendDiscord = makeSendDiscord();
      const handler = makeVoiceRespond({
        manager,
        sendDiscord,
        andyDiscordChannel: 'chan-andy',
      });

      const result = await handler({
        call_id: 'rtc_unknown',
        voice_short: 'fallback voice',
      });

      expect(result).toEqual({
        ok: true,
        result: { matched: false, call_id: 'rtc_unknown' },
      });
      expect(sendDiscord).toHaveBeenCalledOnce();
      expect(sendDiscord).toHaveBeenCalledWith(
        'chan-andy',
        APOLOGY_PREFIX + 'fallback voice',
      );
    });

    it('discord channel not configured: NO post even when matched=false', async () => {
      const manager = makeManager();
      const sendDiscord = makeSendDiscord();
      // andyDiscordChannel undefined → contract says: no post.
      const handler = makeVoiceRespond({ manager, sendDiscord });

      await handler({
        call_id: 'rtc_unknown',
        voice_short: 'kurz',
        discord_long: 'lang',
      });

      expect(sendDiscord).not.toHaveBeenCalled();
    });

    it('sendDiscord callback missing: NO post even when matched=false', async () => {
      const manager = makeManager();
      const handler = makeVoiceRespond({
        manager,
        andyDiscordChannel: 'chan-andy',
      });

      // Just verifying no throw — the contract guards on (sendDiscord && andyDiscordChannel).
      await expect(
        handler({
          call_id: 'rtc_unknown',
          voice_short: 'kurz',
          discord_long: 'lang',
        }),
      ).resolves.toEqual({
        ok: true,
        result: { matched: false, call_id: 'rtc_unknown' },
      });
    });

    it('sendDiscord rejects: error swallowed (fire-and-forget), handler still resolves', async () => {
      const manager = makeManager();
      const sendDiscord = vi.fn().mockRejectedValue(new Error('discord 503'));
      const handler = makeVoiceRespond({
        manager,
        sendDiscord,
        andyDiscordChannel: 'chan-andy',
      });

      // Handler returns normally — the .catch on the fire-and-forget chain
      // logs the error and never re-throws.
      const result = await handler({
        call_id: 'rtc_unknown',
        voice_short: 'kurz',
        discord_long: 'lang',
      });
      expect(result).toEqual({
        ok: true,
        result: { matched: false, call_id: 'rtc_unknown' },
      });
      // Let the rejected promise's .catch handler tick.
      await new Promise((r) => setImmediate(r));
      expect(sendDiscord).toHaveBeenCalledOnce();
    });
  });

  describe('schema validation', () => {
    it('missing call_id: BadRequestError', async () => {
      const handler = makeVoiceRespond({ manager: makeManager() });
      await expect(
        handler({ voice_short: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it('empty call_id: BadRequestError', async () => {
      const handler = makeVoiceRespond({ manager: makeManager() });
      await expect(
        handler({ call_id: '', voice_short: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it('voice_short too long (>500 chars): BadRequestError', async () => {
      const handler = makeVoiceRespond({ manager: makeManager() });
      await expect(
        handler({ call_id: 'rtc_1', voice_short: 'x'.repeat(501) }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it('discord_long too long (>20000 chars): BadRequestError', async () => {
      const handler = makeVoiceRespond({ manager: makeManager() });
      await expect(
        handler({
          call_id: 'rtc_1',
          voice_short: 'x',
          discord_long: 'x'.repeat(20001),
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it('discord_long: null is accepted (nullish)', async () => {
      const manager = makeManager();
      const sendDiscord = makeSendDiscord();
      const handler = makeVoiceRespond({
        manager,
        sendDiscord,
        andyDiscordChannel: 'chan-andy',
      });
      const pending = manager.register('rtc_n', 5000);
      await handler({
        call_id: 'rtc_n',
        voice_short: 'kurz',
        discord_long: null,
      });
      await expect(pending).resolves.toEqual({
        voice_short: 'kurz',
        discord_long: null,
      });
      expect(sendDiscord).not.toHaveBeenCalled();
    });
  });
});
