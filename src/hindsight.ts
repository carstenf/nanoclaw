import { HindsightClient } from '@vectorize-io/hindsight-client';

import { logger } from './logger.js';

// Lazily initialized — only if HINDSIGHT_URL is set
let client: HindsightClient | null = null;

function getClient(): HindsightClient | null {
  if (client) return client;
  const url = process.env.HINDSIGHT_URL;
  if (!url) return null;
  client = new HindsightClient({ baseUrl: url });
  return client;
}

const BANK_ID = 'carsten';

/**
 * Recall relevant memories before the agent runs.
 * Returns a formatted string to inject into the prompt, or null if unavailable.
 */
export async function recallMemory(
  _groupFolder: string,
  query: string,
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const bankId = BANK_ID;
  try {
    const response = await c.recall(bankId, query, { budget: 'mid' });
    if (!response.results || response.results.length === 0) return null;
    const texts = response.results.map((r) => r.text).join('\n');
    return texts;
  } catch (err) {
    logger.warn(
      { err, bankId },
      'Hindsight recall failed, continuing without memory',
    );
    return null;
  }
}

/**
 * Store a conversation in Hindsight after the agent responds.
 * Fire-and-forget — failures are logged but do not affect the main flow.
 */
export async function retainMemory(
  _groupFolder: string,
  content: string,
): Promise<void> {
  const c = getClient();
  if (!c) return;

  const bankId = BANK_ID;
  try {
    await c.retain(bankId, content);
  } catch (err) {
    logger.warn({ err, bankId }, 'Hindsight retain failed');
  }
}
