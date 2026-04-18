/**
 * flat-db-reader.ts
 *
 * mtime-cached JSON file loader for flat data files (contracts, practice profiles).
 * Supports dependency injection of fs for testing.
 * Live-edit friendly: re-reads file when mtime changes, no service restart needed.
 */

import fsPromises from 'fs/promises';

import { logger } from '../logger.js';

interface CacheEntry<T> {
  content: T;
  mtimeMs: number;
}

// Module-level cache: path -> CacheEntry
const CACHE = new Map<string, CacheEntry<unknown>>();

/** Clear the module-level cache (for tests and targeted invalidation). */
export function clearFlatDbCache(): void {
  CACHE.clear();
}

/** Thrown when the target file does not exist (ENOENT). */
export class FlatDbNotFound extends Error {
  readonly code = 'ENOENT';
  constructor(public readonly filePath: string) {
    super(`flat-db file not found: ${filePath}`);
    this.name = 'FlatDbNotFound';
  }
}

/** Thrown when the file exists but is not valid JSON. */
export class FlatDbParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly parseMessage: string,
  ) {
    super(`flat-db parse error in ${filePath}: ${parseMessage}`);
    this.name = 'FlatDbParseError';
  }
}

/** Minimal fs interface for DI. */
interface FsLike {
  stat(path: string): Promise<{ mtimeMs: number }>;
  readFile(path: string, encoding: string): Promise<string>;
}

/** Options for readFlatDb (used for test DI). */
export interface ReadFlatDbOpts {
  /** Override fs/promises implementation (for tests). */
  fs?: FsLike;
}

/**
 * Read a flat JSON file with mtime-based cache.
 *
 * - Returns cached value if file mtime unchanged.
 * - On ENOENT: throws FlatDbNotFound.
 * - On SyntaxError: logs WARN and throws FlatDbParseError.
 *
 * @param filePath  Absolute path to the JSON file.
 * @param _defaultValue  Not used as return, kept for type inference convenience.
 * @param opts  Optional DI (fs override for tests).
 */
export async function readFlatDb<T>(
  filePath: string,
  _defaultValue: T,
  opts: ReadFlatDbOpts = {},
): Promise<T> {
  const fs = (opts.fs as FsLike | undefined) ?? fsPromises;

  try {
    const stat = await fs.stat(filePath);
    const mtimeMs = stat.mtimeMs;

    const cached = CACHE.get(filePath) as CacheEntry<T> | undefined;
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.content;
    }

    const text = await (fs.readFile as (p: string, enc: string) => Promise<string>)(
      filePath,
      'utf8',
    );
    const parsed = JSON.parse(text) as T;
    CACHE.set(filePath, { content: parsed, mtimeMs });
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FlatDbNotFound(filePath);
    }
    if (err instanceof SyntaxError) {
      logger.warn({
        event: 'flat_db_parse_error',
        filePath,
        message: err.message,
      });
      throw new FlatDbParseError(filePath, err.message);
    }
    throw err;
  }
}
