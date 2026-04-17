// voice-bridge/src/turn-timing.ts
// D-37 / REQ-INFRA-05 / REQ-VOICE-10: per-turn JSONL latency sink.
// Writes text JSONL (explicitly allowed by D-20; audio-guard.sh whitelists
// .jsonl on every line match). One file per call: turns-{call_id}.jsonl
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface TurnTimingEntry {
  ts_iso: string
  call_id: string
  turn_id: string
  t0_vad_end_ms: number
  t2_first_llm_token_ms: number | null
  t4_first_tts_audio_ms: number | null
  barge_in: boolean
}

export interface TurnLog {
  append: (entry: TurnTimingEntry) => void
  close: () => Promise<void>
  path: string
}

function baseDir(): string {
  return (
    process.env.BRIDGE_LOG_DIR ??
    join(homedir(), 'nanoclaw', 'voice-container', 'runs')
  )
}

export function openTurnLog(callId: string): TurnLog {
  const dir = baseDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `turns-${callId}.jsonl`)
  const ws = createWriteStream(path, { flags: 'a', encoding: 'utf8' })
  return {
    append(entry: TurnTimingEntry): void {
      ws.write(JSON.stringify(entry) + '\n')
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        ws.end(() => resolve())
      })
    },
    path,
  }
}
