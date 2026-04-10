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
  acceptOpenAICallForOutbound,
} from './freeswitch-voice.js';

const env = readEnvFile([
  'OPENAI_SIP_API_KEY',
  'HINDSIGHT_LLM_API_KEY',
  'OPENAI_PROJECT_ID',
  'OPENAI_WEBHOOK_SECRET',
  'SIPGATE_VOICE_PORT',
  'INBOUND_CALLER_WHITELIST',
]);

const OPENAI_API_KEY =
  env.OPENAI_SIP_API_KEY || env.HINDSIGHT_LLM_API_KEY || '';
const PROJECT_ID = env.OPENAI_PROJECT_ID || '';
const WEBHOOK_SECRET = env.OPENAI_WEBHOOK_SECRET || '';
const PORT = parseInt(env.SIPGATE_VOICE_PORT || '4402', 10);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Inbound caller whitelist (E.164 numbers, comma-separated in .env).
 *
 * Why: SIP scanners and PSTN spammers continuously hit our Sipgate trunk and
 * the Hetzner FreeSWITCH instance, each call would otherwise reach OpenAI
 * Realtime and burn tokens (Realtime = $0.06/min input + $0.24/min output).
 * Without a filter the OpenAI account drains by itself.
 *
 * Hard whitelist: only From numbers listed here will be accepted as inbound.
 * Anything else gets a SIP 486 (Busy Here) reject before any OpenAI session
 * is created.
 *
 * Set INBOUND_CALLER_WHITELIST in .env, e.g.:
 *   INBOUND_CALLER_WHITELIST=+491708036426,+498912345678
 *
 * Empty / unset = allow nothing (safe default — fix .env to enable inbound).
 */
const WHITELIST_RAW = env.INBOUND_CALLER_WHITELIST || '';
const INBOUND_WHITELIST = new Set(
  WHITELIST_RAW.split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0),
);

/**
 * Extract the caller's E.164 number from an OpenAI realtime.call.incoming
 * webhook payload. Looks at the From and Remote-Party-ID SIP headers and
 * returns the bare phone number in E.164 form (+49...) if found.
 */
function extractCallerNumber(event: any): string | null {
  const headers: Array<{ name: string; value: string }> =
    event?.data?.sip_headers || [];
  // Prefer Remote-Party-ID (more reliable for caller identification),
  // fall back to From.
  const candidates = ['Remote-Party-ID', 'From'];
  for (const wantName of candidates) {
    const h = headers.find(
      (x) => x.name?.toLowerCase() === wantName.toLowerCase(),
    );
    if (!h) continue;
    // Match a SIP URI like sip:+491708036426@... or sip:491708036426@...
    const m = h.value.match(/sip:(\+?\d+)@/);
    if (m && m[1]) {
      let num = m[1].startsWith('+') ? m[1] : `+${m[1]}`;
      // Sipgate sends national format (01708036426) — normalize to E.164
      if (num.startsWith('+0')) {
        num = '+49' + num.slice(2);
      }
      return num;
    }
  }
  return null;
}

function isWhitelisted(callerNumber: string | null): boolean {
  if (!callerNumber) return false;
  return INBOUND_WHITELIST.has(callerNumber);
}

/**
 * Extract the X-Nanoclaw-CallId custom SIP header from a webhook payload.
 *
 * Used by the pre-bridge outbound flow: when NanoClaw originates a SIP
 * INVITE to OpenAI directly (before calling the user via Sipgate), it
 * tags the INVITE with `sip_h_X-Nanoclaw-CallId=<callId>`. OpenAI
 * forwards all SIP headers in the realtime.call.incoming webhook, so
 * we can correlate the webhook back to the originating call without
 * relying on caller-id heuristics that race with SIP-spam scanners.
 *
 * Empirically verified 2026-04-09 — OpenAI does pass through custom
 * X-* headers in the sip_headers array.
 */
function extractNanoclawCallId(event: any): string | null {
  const headers: Array<{ name: string; value: string }> =
    event?.data?.sip_headers || [];
  const h = headers.find((x) => x.name?.toLowerCase() === 'x-nanoclaw-callid');
  return h?.value || null;
}

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
      // Two extraction paths:
      //   1. X-Nanoclaw-CallId — set by the pre-bridge outbound flow as a
      //      custom SIP header. Reliable, racing-immune correlation.
      //   2. Caller number — legacy fallback for old originate paths and
      //      for inbound whitelist checks.
      const nanoclawCallId = extractNanoclawCallId(event);
      const callerNumber = extractCallerNumber(event);
      logger.info(
        {
          openaiCallId,
          nanoclawCallId,
          callerNumber,
          pendingFS: [...pendingFSWebhook.keys()],
        },
        'Incoming call webhook — searching for matching call',
      );

      // Strategy 1: match by X-Nanoclaw-CallId header (preferred).
      // The header value is the NanoClaw-internal callId (e.g., fs-out-...),
      // which is also the key in pendingFSWebhook. Direct lookup, O(1).
      //
      // IMPORTANT: we MUST call accept() here ourselves and only resolve
      // the promise after accept succeeds. The pre-bridge originate in
      // makeFreeswitchCall is blocked on the SIP 200 OK from OpenAI, and
      // OpenAI only sends 200 OK after we call accept via the API.
      // Resolving the promise without calling accept would deadlock the
      // originate (it times out as NORMAL_TEMPORARY_FAILURE).
      if (nanoclawCallId && pendingFSWebhook.has(nanoclawCallId)) {
        const pending = pendingFSWebhook.get(nanoclawCallId)!;
        logger.info(
          { callId: nanoclawCallId, openaiCallId },
          'Matched webhook to pending FreeSWITCH outbound call (by X-Nanoclaw-CallId header)',
        );
        (pending.state as any).openaiCallId = openaiCallId;
        pendingFSWebhook.delete(nanoclawCallId);
        res.status(200).send('OK');
        // Call accept() now so OpenAI sends 200 OK to FreeSWITCH and the
        // pre-bridge originate can complete. Resolve the promise only
        // after accept finishes — that signals the OpenAI leg is fully ready.
        acceptOpenAICallForOutbound(openaiCallId, pending.state as any)
          .then(() => pending.resolve())
          .catch((err) => pending.reject(err));
        return;
      }

      // Strategy 2 (legacy fallback): match by caller number.
      // Used for outbound paths that don't yet set the custom header. Will
      // be removed once all outbound paths use the pre-bridge flow.
      for (const [key, pending] of pendingFSWebhook) {
        const expectedCaller = (pending.state as any).to as string | undefined;
        if (expectedCaller && callerNumber && callerNumber === expectedCaller) {
          logger.info(
            { callId: key, openaiCallId, callerNumber },
            'Matched webhook to pending FreeSWITCH outbound call (by caller number, legacy)',
          );
          (pending.state as any).openaiCallId = openaiCallId;
          pendingFSWebhook.delete(key);
          res.status(200).send('OK');
          // Same accept-then-resolve pattern as the header path
          acceptOpenAICallForOutbound(openaiCallId, pending.state as any)
            .then(() => pending.resolve())
            .catch((err) => pending.reject(err));
          return;
        }
      }

      // No pending outbound matched (or this caller wasn't ours). Apply
      // caller whitelist BEFORE creating an OpenAI session, otherwise spam
      // SIP scanners burn tokens. The whitelist is configured via
      // INBOUND_CALLER_WHITELIST in .env (comma-separated E.164 numbers).
      // Empty = reject all inbound. Note: callerNumber was already extracted
      // above so we can reuse it.
      const allowed = isWhitelisted(callerNumber);
      logger.info(
        {
          openaiCallId,
          callerNumber,
          allowed,
          whitelistSize: INBOUND_WHITELIST.size,
        },
        'Inbound caller whitelist check',
      );

      if (!allowed) {
        logger.warn(
          { openaiCallId, callerNumber },
          'Inbound caller NOT in whitelist — rejecting with SIP 486',
        );
        res.status(200).send('OK');
        try {
          await openai.realtime.calls.reject(openaiCallId, {
            status_code: 486,
          });
        } catch (err: any) {
          logger.warn(
            { openaiCallId, err: err?.message },
            'reject() failed (probably already gone)',
          );
        }
        return;
      }

      logger.info(
        { openaiCallId, callerNumber },
        'No pending outbound — whitelisted inbound call, accepting',
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
