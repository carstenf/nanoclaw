import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTurnLog, type TurnTimingEntry } from '../src/turn-timing.js'

describe('openTurnLog — D-37 per-call JSONL sink', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-'))
    process.env.BRIDGE_LOG_DIR = dir
  })
  afterEach(() => {
    delete process.env.BRIDGE_LOG_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes turns-{callId}.jsonl with round-trippable fields', async () => {
    const tl = openTurnLog('rtc_abc')
    const e1: TurnTimingEntry = {
      ts_iso: '2026-04-17T10:00:00Z',
      call_id: 'rtc_abc',
      turn_id: 't1',
      t0_vad_end_ms: 0,
      t2_first_llm_token_ms: 180,
      t4_first_tts_audio_ms: 640,
      barge_in: false,
    }
    const e2: TurnTimingEntry = {
      ts_iso: '2026-04-17T10:00:05Z',
      call_id: 'rtc_abc',
      turn_id: 't2',
      t0_vad_end_ms: 0,
      t2_first_llm_token_ms: 170,
      t4_first_tts_audio_ms: 620,
      barge_in: true,
    }
    tl.append(e1)
    tl.append(e2)
    await tl.close()
    const path = join(dir, 'turns-rtc_abc.jsonl')
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const p0 = JSON.parse(lines[0])
    const p1 = JSON.parse(lines[1])
    expect(p0.turn_id).toBe('t1')
    expect(p0.barge_in).toBe(false)
    expect(p1.turn_id).toBe('t2')
    expect(p1.barge_in).toBe(true)
    expect(p1.t2_first_llm_token_ms).toBe(170)
  })

  it('exposes path for caller reference', async () => {
    const tl = openTurnLog('rtc_xyz')
    expect(tl.path).toBe(join(dir, 'turns-rtc_xyz.jsonl'))
    // Write once so createWriteStream actually opens the fd before close()
    // tears it down — otherwise the lazy-open can race with afterEach rmSync.
    tl.append({
      ts_iso: '2026-04-17T10:00:00Z',
      call_id: 'rtc_xyz',
      turn_id: 't1',
      t0_vad_end_ms: 0,
      t2_first_llm_token_ms: null,
      t4_first_tts_audio_ms: null,
      barge_in: false,
    })
    await tl.close()
  })

  it('nullable fields serialize as JSON null', async () => {
    const tl = openTurnLog('rtc_null')
    tl.append({
      ts_iso: '2026-04-17T10:00:00Z',
      call_id: 'rtc_null',
      turn_id: 't1',
      t0_vad_end_ms: 0,
      t2_first_llm_token_ms: null,
      t4_first_tts_audio_ms: null,
      barge_in: false,
    })
    await tl.close()
    const line = readFileSync(join(dir, 'turns-rtc_null.jsonl'), 'utf8').trim()
    const parsed = JSON.parse(line)
    expect(parsed.t2_first_llm_token_ms).toBeNull()
    expect(parsed.t4_first_tts_audio_ms).toBeNull()
  })
})
