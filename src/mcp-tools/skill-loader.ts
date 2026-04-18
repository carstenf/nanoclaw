/**
 * skill-loader.ts
 *
 * mtime-cached Skill file loader.
 * Reads SKILL.md from data/skills/ask-core-<topic>/ directories.
 * Separate cache namespace from flat-db-reader (different directory, different semantics).
 * Supports dependency injection of fs for testing.
 * Live-edit friendly: re-reads file when mtime changes.
 */

import fsPromises from 'fs/promises';

import { SKILLS_DIR } from '../config.js';

export interface SkillLoadResult {
  /** Whether the skill file exists. */
  exists: boolean;
  /** File contents, or null if not found. */
  body: string | null;
  /** Resolved path that was attempted. */
  path: string;
}

interface CacheEntry {
  mtimeMs: number;
  body: string;
}

/** Module-level skill cache: path -> CacheEntry. Separate from flat-db-reader CACHE. */
const SKILL_CACHE = new Map<string, CacheEntry>();

/** Clear the skill cache (for tests and targeted invalidation). */
export function clearSkillCache(): void {
  SKILL_CACHE.clear();
}

/** Minimal fs interface for DI. */
interface FsLike {
  stat(path: string): Promise<{ mtimeMs: number }>;
  readFile(path: string, encoding: string): Promise<string>;
}

export interface LoadSkillOpts {
  /** Override the skills base directory (for tests). Default: SKILLS_DIR */
  skillsDir?: string;
  /** Override fs/promises implementation (for tests). */
  fs?: FsLike;
}

/**
 * Load a skill's SKILL.md with mtime-based caching.
 *
 * - Path: `${skillsDir}/ask-core-${topic}/SKILL.md`
 * - Returns cached value if file mtime unchanged.
 * - On ENOENT: returns {exists: false, body: null, path}.
 * - Other fs errors are re-thrown (caller handles).
 *
 * @param topic  Skill topic slug (e.g. "test", "hotel").
 * @param opts   Optional overrides for DI.
 */
export async function loadSkill(
  topic: string,
  opts: LoadSkillOpts = {},
): Promise<SkillLoadResult> {
  const skillsDir = opts.skillsDir ?? SKILLS_DIR;
  const fs = (opts.fs as FsLike | undefined) ?? fsPromises;

  const filePath = `${skillsDir}/ask-core-${topic}/SKILL.md`;

  try {
    const stat = await fs.stat(filePath);
    const mtimeMs = stat.mtimeMs;

    const cached = SKILL_CACHE.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return { exists: true, body: cached.body, path: filePath };
    }

    const body = await (
      fs.readFile as (p: string, enc: string) => Promise<string>
    )(filePath, 'utf8');

    SKILL_CACHE.set(filePath, { mtimeMs, body });
    return { exists: true, body, path: filePath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, body: null, path: filePath };
    }
    throw err;
  }
}
