// voice-bridge/src/ghost-scan.ts
// D-18 per-call ghost scan. Run after session.closed OR force-close.
// Audio extensions only — text formats (.jsonl/.log/.txt) are whitelisted
// implicitly (not in AUDIO_EXTS).
import { readdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import type { Logger } from 'pino'

const AUDIO_EXTS = new Set([
  '.wav',
  '.mp3',
  '.opus',
  '.flac',
  '.pcm',
  '.ogg',
  '.m4a',
  '.aac',
  '.webm',
])

export async function runGhostScan(
  callId: string,
  log: Logger,
  rootsOverride?: string[],
): Promise<string[]> {
  const roots = rootsOverride ?? [
    join(homedir(), 'nanoclaw'),
    join(homedir(), '.cache'),
    '/tmp',
  ]
  const hits: string[] = []
  for (const root of roots) {
    await walk(root, hits)
  }
  if (hits.length === 0) {
    log.info({ event: 'ghost_scan_clean', call_id: callId })
  } else {
    for (const p of hits) {
      log.warn({ event: 'ghost_scan_hit', call_id: callId, path: p })
    }
  }
  return hits
}

async function walk(dir: string, hits: string[]): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // EACCES / ENOENT — skip silently
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      await walk(full, hits)
      continue
    }
    const ext = extname(full).toLowerCase()
    if (AUDIO_EXTS.has(ext)) {
      hits.push(full)
    }
  }
}
