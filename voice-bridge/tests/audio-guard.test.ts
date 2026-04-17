// voice-bridge/tests/audio-guard.test.ts
// D-23: regression test for the §201 StGB audio-write guard.
// Seeds violations in a temp repo and asserts audio-guard.sh exit codes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SCRIPT = resolve(__dirname, '../scripts/audio-guard.sh')

function runGuard(root: string): { status: number; stdout: string } {
  try {
    const out = execFileSync(
      'bash',
      [join(root, 'voice-bridge', 'scripts', 'audio-guard.sh')],
      { stdio: 'pipe' },
    )
    return { status: 0, stdout: out.toString() }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
    return {
      status: err.status ?? -1,
      stdout: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? ''),
    }
  }
}

describe('audio-guard.sh — D-23 regression test', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'audio-guard-'))
    mkdirSync(join(root, 'voice-bridge', 'src'), { recursive: true })
    mkdirSync(join(root, 'voice-bridge', 'scripts'), { recursive: true })
    cpSync(SCRIPT, join(root, 'voice-bridge', 'scripts', 'audio-guard.sh'))
    chmodSync(join(root, 'voice-bridge', 'scripts', 'audio-guard.sh'), 0o755)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('passes when no audio writes exist', () => {
    writeFileSync(
      join(root, 'voice-bridge', 'src', 'clean.ts'),
      "export function noop() { return 42 }\n",
    )
    const { status, stdout } = runGuard(root)
    expect(status).toBe(0)
    expect(stdout).toContain('clean')
  })

  it('fails (exit 1) when a .wav createWriteStream is present', () => {
    writeFileSync(
      join(root, 'voice-bridge', 'src', 'bad.ts'),
      "import { createWriteStream } from 'node:fs'\n" +
        "createWriteStream('/tmp/counterpart.wav')\n",
    )
    const { status } = runGuard(root)
    expect(status).toBe(1)
  })

  it('fails when Python fopen write mode appears (D-22 regression guard)', () => {
    mkdirSync(join(root, 'voice-container'), { recursive: true })
    writeFileSync(
      join(root, 'voice-container', 'whisper_stub.py'),
      "f = fopen('audio.pcm', 'w')\n",
    )
    const { status } = runGuard(root)
    expect(status).toBe(1)
  })

  it('allows createWriteStream for .jsonl / .log / .txt (D-20 exception)', () => {
    writeFileSync(
      join(root, 'voice-bridge', 'src', 'turn-timing.ts'),
      "import { createWriteStream } from 'node:fs'\n" +
        "createWriteStream('/tmp/calls/turns-rtc_1.jsonl')\n" +
        "createWriteStream('/tmp/debug.log')\n" +
        "createWriteStream('/tmp/notes.txt')\n",
    )
    const { status, stdout } = runGuard(root)
    expect(status).toBe(0)
    expect(stdout).toContain('clean')
  })
})
