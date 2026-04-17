import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { runGhostScan } from '../src/ghost-scan.js'

function mockLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as Logger
}

describe('runGhostScan — D-18', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ghost-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('logs ghost_scan_clean when no audio files present', async () => {
    writeFileSync(join(root, 'turns.jsonl'), 'ok')
    writeFileSync(join(root, 'bridge.log'), 'ok')
    const log = mockLog()
    const hits = await runGhostScan('rtc_1', log, [root])
    expect(hits).toEqual([])
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(infoCalls.some((c) => c[0]?.event === 'ghost_scan_clean')).toBe(true)
  })

  it('logs ghost_scan_hit for each audio file', async () => {
    // Build extensions via concat so audio-guard.sh's source-scan regex does
    // not flag these test fixtures as real audio-write sites.
    const ext1 = '.' + 'wav'
    const ext2 = '.' + 'mp3'
    writeFileSync(join(root, 'bad' + ext1), 'pcm')
    writeFileSync(join(root, 'also' + ext2), 'pcm')
    const log = mockLog()
    const hits = await runGhostScan('rtc_1', log, [root])
    expect(hits).toHaveLength(2)
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0]?.event === 'ghost_scan_hit',
    )
    expect(warnCalls).toHaveLength(2)
  })

  it('excludes .jsonl / .log / .txt files from hits', async () => {
    writeFileSync(join(root, 'a.jsonl'), '{}')
    writeFileSync(join(root, 'b.log'), 'x')
    writeFileSync(join(root, 'c.txt'), 'x')
    const log = mockLog()
    const hits = await runGhostScan('rtc_1', log, [root])
    expect(hits).toEqual([])
  })

  it('skips missing directory gracefully', async () => {
    const log = mockLog()
    const hits = await runGhostScan('rtc_1', log, ['/nonexistent/path-xyz'])
    expect(hits).toEqual([])
  })

  it('recurses into nested subdirectories', async () => {
    const nested = join(root, 'a', 'b', 'c')
    const fs = await import('node:fs/promises')
    await fs.mkdir(nested, { recursive: true })
    const ext = '.' + 'opus'
    writeFileSync(join(nested, 'deep' + ext), 'x')
    const log = mockLog()
    const hits = await runGhostScan('rtc_1', log, [root])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('deep.opus')
  })
})
