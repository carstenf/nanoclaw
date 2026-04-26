/**
 * MCP tool: voice_respond
 *
 * Andy (running in the whatsapp_main container) calls this tool to deliver
 * the result of a voice_request that was injected into his IPC input via
 * voice-ask-core. The tool handler resolves the matching pending Promise in
 * the VoiceRespondManager so voice-ask-core can return the payload to the
 * voice-bridge as the ask_core tool result.
 *
 * If `discord_long` is provided AND a Discord channel is configured, the
 * long-form text is sent to Discord fire-and-forget.
 */
import { z } from 'zod';
import { BadRequestError } from './voice-on-transcript-turn.js';
import type { VoiceRespondManager } from '../voice-channel/index.js';
import { logger } from '../logger.js';

export const VoiceRespondSchema = z.object({
  call_id: z.string().min(1).max(128),
  voice_short: z.string().min(1).max(500),
  discord_long: z.string().max(20000).nullish(),
});

export type VoiceRespondInput = z.infer<typeof VoiceRespondSchema>;

export interface VoiceRespondDeps {
  manager: VoiceRespondManager;
  /** Optional Discord delivery for the long-form payload. Fire-and-forget. */
  sendDiscord?: (
    channelId: string,
    content: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Discord channel for Andy's long-form posts. */
  andyDiscordChannel?: string;
}

export function makeVoiceRespond(deps: VoiceRespondDeps) {
  return async function voiceRespond(args: unknown): Promise<unknown> {
    const parsed = VoiceRespondSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }
    const { call_id, voice_short, discord_long } = parsed.data;

    const matched = deps.manager.resolve(call_id, {
      voice_short,
      discord_long: discord_long ?? null,
    });

    // Discord delivery contract:
    //  - matched + discord_long present → post discord_long (long-form follow-up
    //    while voice plays voice_short).
    //  - !matched (manager timed out before Andy answered) → ALWAYS post to
    //    Discord so the caller gets the answer somewhere. Prefer discord_long
    //    if Andy supplied one, else fall back to voice_short.
    if (deps.sendDiscord && deps.andyDiscordChannel) {
      const fallbackBody = !matched
        ? discord_long || voice_short
        : discord_long;
      if (fallbackBody) {
        const reasonPrefix = !matched
          ? '(Andy ist langsamer als der Voice-Timeout — Antwort kommt deshalb hier auf Discord) '
          : '';
        void deps
          .sendDiscord(
            deps.andyDiscordChannel,
            reasonPrefix + fallbackBody,
          )
          .catch((err: unknown) => {
            logger.warn(
              {
                event: 'voice_respond_discord_send_failed',
                call_id,
                matched,
                err: (err as Error)?.message ?? String(err),
              },
              'discord delivery failed',
            );
          });
      }
    }

    return {
      ok: true as const,
      result: { matched, call_id },
    };
  };
}
