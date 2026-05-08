// src/memory.ts
//
// Generic memory abstraction for NanoClaw. Trunk knows nothing about
// hindsight, mem0, letta, postgres-vector, etc. — it just calls
// `memory_recall` and `memory_retain` MCP tools on whatever MCP server is
// configured via MEMORY_MCP_URL.
//
// Activation: set MEMORY_MCP_URL=http://host:port/mcp in .env. Without it
// recallMemory/retainMemory are silent no-ops, so trunk runs unchanged
// when no memory provider is installed.
//
// Memory providers ship as separate skills/repos (e.g. nanoclaw-hindsight)
// that run an MCP server exposing the two tools below. New providers drop
// in by speaking the same MCP contract — no nanoclaw changes.
//
// Tool contract:
//   memory_recall(group: string, query: string) → text content (relevant
//     memories formatted as a string) or empty / no content if nothing
//     applicable.
//   memory_retain(group: string, content: string) → ack, fire-and-forget
//     from caller perspective.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const TOOL_RECALL = 'memory_recall' as const;
const TOOL_RETAIN = 'memory_retain' as const;

let client: Client | null = null;
let initialized = false;
let initInFlight: Promise<Client | null> | null = null;

async function initClient(): Promise<Client | null> {
  if (initialized) return client;
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    initialized = true;
    // .env is not auto-loaded into process.env (no dotenv import; systemd unit
    // doesn't EnvironmentFile=). Read explicitly via readEnvFile, with
    // process.env as fallback for callers that pre-set it (tests, CI).
    const env = readEnvFile(['MEMORY_MCP_URL', 'MEMORY_MCP_BEARER']);
    const url = env.MEMORY_MCP_URL || process.env.MEMORY_MCP_URL;
    const bearer = env.MEMORY_MCP_BEARER || process.env.MEMORY_MCP_BEARER;
    if (!url) {
      logger.info({ event: 'memory_mcp_disabled', reason: 'MEMORY_MCP_URL_unset' });
      return null;
    }
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: bearer
          ? { headers: { Authorization: `Bearer ${bearer}` } }
          : undefined,
      });
      const c = new Client(
        { name: 'nanoclaw-memory-client', version: '1.0.0' },
        { capabilities: {} },
      );
      await c.connect(transport);
      client = c;
      logger.info({ event: 'memory_mcp_connected', url });
      return client;
    } catch (err) {
      logger.warn({
        event: 'memory_mcp_connect_failed',
        url,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  })();
  return initInFlight;
}

interface ContentItem {
  type: string;
  text?: string;
}

function extractText(result: unknown): string | null {
  const r = result as { content?: ContentItem[] } | undefined;
  if (!r?.content || !Array.isArray(r.content)) return null;
  const text = r.content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Recall relevant memories before the agent runs. Calls memory_recall MCP
 * tool on the configured memory server. Returns a formatted string for
 * prompt injection, or null when no memories / no provider / error.
 */
export async function recallMemory(
  group: string,
  query: string,
): Promise<string | null> {
  const c = await initClient();
  if (!c) return null;
  try {
    const result = await c.callTool({
      name: TOOL_RECALL,
      arguments: { group, query },
    });
    return extractText(result);
  } catch (err) {
    logger.warn({
      event: 'memory_recall_failed',
      group,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Store a conversation after the agent responds. Calls memory_retain MCP
 * tool. Fire-and-forget from caller perspective — failures are logged.
 */
export async function retainMemory(
  group: string,
  content: string,
): Promise<void> {
  const c = await initClient();
  if (!c) return;
  try {
    await c.callTool({
      name: TOOL_RETAIN,
      arguments: { group, content },
    });
  } catch (err) {
    logger.warn({
      event: 'memory_retain_failed',
      group,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
