// voice-bridge/src/logger.ts
// Per Pitfall NEW-5: both transports default to INFO. If LOG_LEVEL=debug
// is needed, raise BRIDGE_LOG_LEVEL_FILE separately to avoid journald
// disk pressure.
import pino from 'pino'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export function buildLogger(): pino.Logger {
  const dir =
    process.env.BRIDGE_LOG_DIR ??
    join(homedir(), 'nanoclaw', 'voice-container', 'runs')
  mkdirSync(dir, { recursive: true })

  const transport = pino.transport({
    targets: [
      {
        target: 'pino-roll',
        options: {
          file: join(dir, 'bridge'), // pino-roll appends -YYYY-MM-DD
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          extension: '.jsonl',
          mkdir: true,
        },
        level: process.env.LOG_LEVEL ?? 'info',
      },
      {
        target: 'pino/file', // also stdout for journald
        options: { destination: 1 },
        level: process.env.LOG_LEVEL ?? 'info',
      },
    ],
  })
  return pino({ base: { svc: 'voice-bridge' } }, transport)
}
