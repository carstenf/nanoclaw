/**
 * OpenAI SIP Webhook Server
 *
 * Receives webhooks from OpenAI when SIP calls arrive.
 * Routes to FreeSWITCH pending outbound calls or handles inbound calls.
 *
 * Replaces the webhook portion of the old sipgate-voice.ts (archived in git).
 * Last working sipgate-voice commit: c926004
 */
import express from 'express';
import OpenAI from 'openai';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  pendingFSWebhook,
  handleFSInboundWebhook,
} from './freeswitch-voice.js';

const env = readEnvFile([
  'OPENAI_SIP_API_KEY',
  'HINDSIGHT_LLM_API_KEY',
  'OPENAI_PROJECT_ID',
  'OPENAI_WEBHOOK_SECRET',
  'SIPGATE_VOICE_PORT',
]);

const OPENAI_API_KEY =
  env.OPENAI_SIP_API_KEY || env.HINDSIGHT_LLM_API_KEY || '';
const PROJECT_ID = env.OPENAI_PROJECT_ID || '';
const WEBHOOK_SECRET = env.OPENAI_WEBHOOK_SECRET || '';
const PORT = parseInt(env.SIPGATE_VOICE_PORT || '4402', 10);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

export function startWebhookServer(): void {
  if (!PROJECT_ID) {
    logger.warn('OPENAI_PROJECT_ID not set — webhook server not started');
    return;
  }

  const app = express();
  app.use(express.raw({ type: 'application/json' }));

  app.post('/openai-sip', async (req, res) => {
    const rawBody = req.body.toString();
    logger.info(
      {
        bodyLen: rawBody.length,
        webhookId: req.headers['webhook-id'],
      },
      'Webhook request received on /openai-sip',
    );

    let event: any;
    try {
      if (WEBHOOK_SECRET) {
        event = await openai.webhooks.unwrap(
          rawBody,
          req.headers,
          WEBHOOK_SECRET,
        );
      } else {
        event = JSON.parse(rawBody);
        logger.warn('Webhook signature not verified — no secret set');
      }
    } catch (err: any) {
      logger.error(
        { err: err?.message },
        'Webhook signature verification failed — rejecting',
      );
      res.status(401).send('Signature verification failed');
      return;
    }

    logger.info(
      { type: event.type, callId: event.call_id || event.data?.call_id },
      'OpenAI webhook event parsed',
    );

    if (event.type === 'realtime.call.incoming') {
      const openaiCallId = event.call_id || event.data?.call_id;
      logger.info(
        {
          openaiCallId,
          pendingFS: [...pendingFSWebhook.keys()],
        },
        'Incoming call webhook — searching for matching call',
      );

      // Check FreeSWITCH pending outbound calls (FIFO — first pending gets first webhook).
      // OpenAI webhook doesn't include originating SIP info, so exact matching isn't possible.
      // Concurrent outbound calls could mis-match; keep outbound calls sequential.
      for (const [key, pending] of pendingFSWebhook) {
        logger.info(
          { callId: key, openaiCallId },
          'Matched webhook to pending FreeSWITCH outbound call',
        );
        (pending.state as any).openaiCallId = openaiCallId;
        pendingFSWebhook.delete(key);
        res.status(200).send('OK');
        pending.resolve();
        return;
      }

      // No pending outbound — this is an inbound call (FS dialplan auto-bridged)
      logger.info(
        { openaiCallId },
        'No pending outbound — FreeSWITCH inbound call',
      );
      res.status(200).send('OK');
      try {
        handleFSInboundWebhook(openaiCallId);
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to handle FS inbound');
        try {
          await openai.realtime.calls.reject(openaiCallId, {
            status_code: 486,
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    res.status(200).send('OK');
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'OpenAI SIP webhook server started');
  });
}
