/**
 * Auto-wires the universal hindsight-mcp into a new group's container config.
 *
 * Idempotent: returns false if already wired. Called from group-init.ts
 * after `ensureContainerConfig(group.id)`. Installed by `/add-hindsight`
 * skill — remove this file (and its import in group-init.ts) to disable
 * default-wiring for new groups.
 *
 * Writes to the central DB's `container_configs` row (mcp_servers +
 * additional_mounts JSON columns); materialization to
 * `groups/<folder>/container.json` happens at spawn time.
 */
import { getContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import type { McpServerConfig, AdditionalMountConfig } from './container-config.js';

const HINDSIGHT_HOST_PATH = '/home/hindsight-mcp/app';
const HINDSIGHT_CONTAINER_PATH = 'hindsight-mcp';
const HINDSIGHT_ENGINE_URL = 'http://10.0.0.2:3850';
const HINDSIGHT_BANK_PREFIX = 'nanoclaw';

export function ensureHindsightWired(agentGroupId: string, folder: string): boolean {
  const row = getContainerConfig(agentGroupId);
  if (!row) return false;

  const mcpServers: Record<string, McpServerConfig> = JSON.parse(row.mcp_servers || '{}');
  if (mcpServers.hindsight) return false;

  mcpServers.hindsight = {
    command: 'node',
    args: [`/workspace/extra/${HINDSIGHT_CONTAINER_PATH}/dist/server-stdio.js`],
    env: {
      HINDSIGHT_URL: HINDSIGHT_ENGINE_URL,
      HINDSIGHT_BANK_PREFIX: HINDSIGHT_BANK_PREFIX,
    },
    instructions: `You have a per-group long-term memory bank (\`mcp__hindsight__memory_recall\` / \`memory_retain\` / \`memory_reflect\`). Always use \`group="${folder}"\` for this agent. Recall at the start of turns that might benefit from prior context; retain selectively when something durable was produced. **Read the \`hindsight\` skill (Skill tool) for full discipline before your first retain call.** Never claim a memory was saved if you didn't actually call the tool.`,
  };

  const additionalMounts: AdditionalMountConfig[] = JSON.parse(row.additional_mounts || '[]');
  if (!additionalMounts.some((m) => m.hostPath === HINDSIGHT_HOST_PATH)) {
    additionalMounts.push({
      hostPath: HINDSIGHT_HOST_PATH,
      containerPath: HINDSIGHT_CONTAINER_PATH,
      readonly: true,
    });
  }

  updateContainerConfigJson(agentGroupId, 'mcp_servers', mcpServers);
  updateContainerConfigJson(agentGroupId, 'additional_mounts', additionalMounts);
  return true;
}
