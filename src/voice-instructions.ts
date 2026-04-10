/**
 * Voice instructions loader.
 *
 * Reads `voice/SKILL.md` and `groups/<group>/CLAUDE.md` at request time so the
 * user can edit them without rebuilding. Renders the requested section
 * (`outbound` or `inbound`) with `{{persona}}`, `{{goal}}`, `{{now}}` and
 * `{{group}}` substituted.
 *
 * Hardcoded fallbacks are intentionally absent — if the skill file goes
 * missing we fail loudly instead of silently degrading the agent persona.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const VOICE_SKILL_PATH = path.join(PROJECT_ROOT, 'voice', 'SKILL.md');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

export type VoiceDirection = 'outbound' | 'inbound';

export interface RenderVoiceInstructionsParams {
  direction: VoiceDirection;
  group: string;
  goal: string;
}

/**
 * Extract a top-level `## <name>` section from a markdown document.
 * Returns the section body (everything between the heading and the next
 * top-level heading) without the heading line itself.
 */
function extractSection(markdown: string, sectionName: string): string | null {
  const lines = markdown.split('\n');
  const startIdx = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${sectionName.toLowerCase()}`,
  );
  if (startIdx === -1) return null;
  // Find the next ## heading (or end of file)
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  return lines
    .slice(startIdx + 1, endIdx)
    .join('\n')
    .trim();
}

function readGroupPersona(group: string): string {
  const claudeMd = path.join(GROUPS_DIR, group, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    throw new Error(
      `Group persona file not found: ${claudeMd}. ` +
        `Cannot render voice instructions without a persona.`,
    );
  }
  return fs.readFileSync(claudeMd, 'utf8');
}

function readVoiceSkill(): string {
  if (!fs.existsSync(VOICE_SKILL_PATH)) {
    throw new Error(
      `Voice skill file not found: ${VOICE_SKILL_PATH}. ` +
        `Edit voice/SKILL.md to define how Andy behaves on the phone.`,
    );
  }
  return fs.readFileSync(VOICE_SKILL_PATH, 'utf8');
}

/**
 * Render the voice instructions for a given direction (`outbound` / `inbound`).
 *
 * Reads `voice/SKILL.md` fresh on every call so edits are picked up without
 * a restart. The file has three top-level sections:
 *
 *   ## Allgemein         — common to all calls
 *   ## Zusatz Inbound    — appended for inbound calls
 *   ## Zusatz Outbound   — appended for outbound calls
 *
 * Substitutes `{{persona}}`, `{{goal}}`, `{{now}}`, `{{group}}`.
 */
export function renderVoiceInstructions(
  params: RenderVoiceInstructionsParams,
): string {
  const skill = readVoiceSkill();

  const common = extractSection(skill, 'Allgemein');
  if (!common) {
    throw new Error(
      'voice/SKILL.md is missing the "## Allgemein" section (common instructions)',
    );
  }

  const addonName =
    params.direction === 'inbound' ? 'Zusatz Inbound' : 'Zusatz Outbound';
  const addon = extractSection(skill, addonName);
  if (!addon) {
    throw new Error(`voice/SKILL.md is missing the "## ${addonName}" section`);
  }

  const persona = readGroupPersona(params.group);
  const now = new Date().toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  // Common comes first so the persona/role is established before the
  // direction-specific behaviour.
  const combined = `${common}\n\n---\n\n${addon}`;

  return combined
    .replaceAll('{{persona}}', persona.trim())
    .replaceAll('{{goal}}', params.goal || '(kein Ziel angegeben)')
    .replaceAll('{{now}}', now)
    .replaceAll('{{group}}', params.group);
}
