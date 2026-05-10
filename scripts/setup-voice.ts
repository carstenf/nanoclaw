/**
 * Wire the voice channel into the central DB.
 *
 * Idempotent. Creates one voice messaging_group (channel_type='voice',
 * platform_id='default') and links it to the chosen agent group with
 * session_mode='per-thread' so every call_id becomes its own session.
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-voice.ts                       # default agent group
 *   pnpm exec tsx scripts/setup-voice.ts --agent-group=<id>    # explicit
 *   pnpm exec tsx scripts/setup-voice.ts --policy=public       # override unknown_sender_policy
 *
 * Run after voice-mcp is reachable and after VOICE_MCP_URL/_BEARER are
 * in .env. Restart the host afterwards so the voice adapter picks up
 * the new wiring.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';

const VOICE_CHANNEL_TYPE = 'voice';
const VOICE_PLATFORM_ID = 'default';
const VOICE_MG_ID = 'mg-voice';
const VOICE_MGA_ID = 'mga-voice';

type Policy = 'strict' | 'request_approval' | 'public';

interface Args {
  agentGroupId: string | null;
  policy: Policy;
}

function parseArgs(): Args {
  let agentGroupId: string | null = null;
  let policy: Policy = 'request_approval';
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--agent-group=')) {
      agentGroupId = arg.slice('--agent-group='.length);
    } else if (arg.startsWith('--policy=')) {
      const p = arg.slice('--policy='.length);
      if (p === 'strict' || p === 'request_approval' || p === 'public') {
        policy = p;
      } else {
        console.error(`bad --policy=${p} (must be strict | request_approval | public)`);
        process.exit(1);
      }
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return { agentGroupId, policy };
}

function pickDefaultAgentGroup(): string {
  // Prefer a folder named 'dm-with-carsten' (this install's primary DM
  // agent), otherwise pick the lex-smallest agent group as a fallback.
  const db = getDb();
  const dm = db
    .prepare("SELECT id FROM agent_groups WHERE folder = 'dm-with-carsten' LIMIT 1")
    .get() as { id: string } | undefined;
  if (dm) return dm.id;
  const any = db
    .prepare('SELECT id FROM agent_groups ORDER BY id LIMIT 1')
    .get() as { id: string } | undefined;
  if (!any) {
    console.error(
      'No agent groups exist yet. Create one first (e.g. via /init-first-agent) or pass --agent-group=<id>.',
    );
    process.exit(1);
  }
  return any.id;
}

const args = parseArgs();
initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(getDb());

const agentGroupId = args.agentGroupId ?? pickDefaultAgentGroup();
const ag = getAgentGroup(agentGroupId);
if (!ag) {
  console.error(`Agent group ${agentGroupId} not found.`);
  process.exit(1);
}

const existing = getMessagingGroupByPlatform(VOICE_CHANNEL_TYPE, VOICE_PLATFORM_ID);
if (existing) {
  console.log(`voice messaging_group already exists: ${existing.id}`);
  // Sync the policy if it drifted.
  if (existing.unknown_sender_policy !== args.policy) {
    getDb()
      .prepare('UPDATE messaging_groups SET unknown_sender_policy = ? WHERE id = ?')
      .run(args.policy, existing.id);
    console.log(`updated unknown_sender_policy: ${existing.unknown_sender_policy} → ${args.policy}`);
  }
} else {
  createMessagingGroup({
    id: VOICE_MG_ID,
    channel_type: VOICE_CHANNEL_TYPE,
    platform_id: VOICE_PLATFORM_ID,
    name: 'voice',
    is_group: 0,
    unknown_sender_policy: args.policy,
    created_at: new Date().toISOString(),
  });
  console.log(`created voice messaging_group: ${VOICE_MG_ID} (policy=${args.policy})`);
}

const voiceMg = getMessagingGroupByPlatform(VOICE_CHANNEL_TYPE, VOICE_PLATFORM_ID);
if (!voiceMg) {
  console.error('voice messaging_group missing after create — aborting');
  process.exit(1);
}

// Wire the voice MG to the chosen agent group. engage_pattern='.' means
// every voice message engages — voice has no @mention semantic. session_mode
// 'per-thread' gives each call_id its own session/inbound/outbound DBs.
try {
  createMessagingGroupAgent({
    id: VOICE_MGA_ID,
    messaging_group_id: voiceMg.id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  console.log(`wired voice → ${ag.name} (${ag.id})`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('UNIQUE')) {
    console.log(`voice → ${ag.name} wiring already present`);
  } else {
    throw err;
  }
}

console.log('done. restart nanoclaw to pick up the new voice channel:');
console.log('  systemctl --user restart nanoclaw');
