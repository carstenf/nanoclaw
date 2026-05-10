/**
 * Auto-wires the universal hindsight-mcp into a group's container.json.
 *
 * Idempotent: returns false if already wired. Called from group-init.ts
 * after `initContainerConfig`. Installed by `/add-hindsight` skill —
 * remove this file (and its import in group-init.ts) to disable
 * default-wiring for new groups.
 */
import { readContainerConfig, writeContainerConfig } from './container-config.js';

const HINDSIGHT_HOST_PATH = '/home/hindsight-mcp/app';
const HINDSIGHT_CONTAINER_PATH = 'hindsight-mcp';
const HINDSIGHT_ENGINE_URL = 'http://10.0.0.2:3850';
const HINDSIGHT_BANK_PREFIX = 'nanoclaw';

export function ensureHindsightWired(folder: string): boolean {
  const config = readContainerConfig(folder);

  if (config.mcpServers.hindsight) return false;

  config.mcpServers.hindsight = {
    command: 'node',
    args: [`/workspace/extra/${HINDSIGHT_CONTAINER_PATH}/dist/server-stdio.js`],
    env: {
      HINDSIGHT_URL: HINDSIGHT_ENGINE_URL,
      HINDSIGHT_BANK_PREFIX: HINDSIGHT_BANK_PREFIX,
    },
    instructions: `You have a per-group long-term memory bank (\`mcp__hindsight__memory_recall\` / \`memory_retain\` / \`memory_reflect\`). Always use \`group="${folder}"\` for this agent. Recall at the start of turns that might benefit from prior context; retain selectively when something durable was produced. **Read the \`hindsight\` skill (Skill tool) for full discipline before your first retain call.** Never claim a memory was saved if you didn't actually call the tool.`,
  };

  if (!config.additionalMounts.some((m) => m.hostPath === HINDSIGHT_HOST_PATH)) {
    config.additionalMounts.push({
      hostPath: HINDSIGHT_HOST_PATH,
      containerPath: HINDSIGHT_CONTAINER_PATH,
      readonly: true,
    });
  }

  writeContainerConfig(folder, config);
  return true;
}
