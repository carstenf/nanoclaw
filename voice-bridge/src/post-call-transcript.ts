// voice-bridge/src/post-call-transcript.ts
// open_points 2026-04-27 #2 — post-call transcript to Discord.
//
// Reads the per-call voice-trace JSONL, extracts the user/bot transcripts in
// chronological order, formats markdown, chunks to Discord's 2000-char limit,
// and posts each chunk via nanoclaw-mcp's voice_send_discord_message tool.
//
// Triggered fire-and-forget from call-router.ts endCall() after turnLog.close()
// so the JSONL has been fully flushed. Failures are logged, not thrown — call
// teardown must always proceed.

import fs from 'fs'
import path from 'path'
import type { Logger } from 'pino'

import { VOICE_TRACE_DIR } from './config.js'
import type { NanoclawMcpClient } from './nanoclaw-mcp-client.js'

interface TranscriptTurn {
  /** Milliseconds since call open (from voice-trace `t_ms_since_open`). */
  t: number
  /** 'user' = caller utterance; 'bot' = Andy/Realtime audio output. */
  who: 'user' | 'bot'
  text: string
}

const DISCORD_CONTENT_HARD_LIMIT = 2000
// voice_send_discord_message schema caps content at 4000 chars but Discord
// itself rejects single messages > 2000 chars. We chunk to 2000 to stay
// inside Discord's actual limit.
const DISCORD_CHUNK_LIMIT = 1900 // headroom for code-fences + markers

/**
 * Read turns-<callId>.jsonl, extract user + bot transcripts in order.
 * Filters out audio chunks, function_call streaming deltas, and other noise.
 * Returns an empty array if the file is missing or unreadable (caller logs).
 */
export function extractTurnsFromJsonl(
  callId: string,
  voiceTraceDir: string = VOICE_TRACE_DIR,
): TranscriptTurn[] {
  const safe = callId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const filepath = path.join(voiceTraceDir, `turns-${safe}.jsonl`)
  let raw: string
  try {
    raw = fs.readFileSync(filepath, 'utf-8')
  } catch {
    return []
  }
  const turns: TranscriptTurn[] = []
  // Track partial bot transcripts assembled from response.output_audio.* events
  // keyed by item_id, in case multiple bot turns interleave (rare but defensive).
  const botInProgress = new Map<string, string>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let evt: {
      t_ms_since_open?: number
      type?: string
      transcript?: string
      item_id?: string
      response?: {
        output?: Array<{
          id?: string
          content?: Array<{ transcript?: string; type?: string }>
        }>
      }
    }
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    const t = typeof evt.t_ms_since_open === 'number' ? evt.t_ms_since_open : 0
    // User transcript (Whisper transcription of caller utterance).
    if (
      evt.type === 'conversation.item.input_audio_transcription.completed' &&
      typeof evt.transcript === 'string' &&
      evt.transcript.trim().length > 0
    ) {
      turns.push({ t, who: 'user', text: evt.transcript.trim() })
      continue
    }
    // Bot transcript: response.done payload includes output[*].content[*]
    // with type='output_audio' and transcript field. We pick those out as the
    // canonical "what the bot said" — much cleaner than reconstructing from
    // delta streams.
    if (evt.type === 'response.done' && Array.isArray(evt.response?.output)) {
      for (const item of evt.response.output) {
        if (!Array.isArray(item.content)) continue
        for (const c of item.content) {
          if (
            (c.type === 'output_audio' || c.type === 'audio') &&
            typeof c.transcript === 'string' &&
            c.transcript.trim().length > 0
          ) {
            turns.push({ t, who: 'bot', text: c.transcript.trim() })
          }
        }
      }
      // Clear in-progress entries that resolved.
      for (const item of evt.response.output) {
        if (item.id) botInProgress.delete(item.id)
      }
    }
  }
  // Stable sort by t to ensure chronological order even if events arrived
  // slightly out-of-order (shouldn't happen but defensive).
  turns.sort((a, b) => a.t - b.t)
  return turns
}

export interface FormatHeader {
  callId: string
  durationMs: number
  callerNumber?: string
  caseType?: string
}

/**
 * Build the markdown body. Header + alternating turns.
 * Returns one string; chunkForDiscord splits if necessary.
 */
export function formatTranscript(
  header: FormatHeader,
  turns: TranscriptTurn[],
): string {
  const headerLines: string[] = []
  headerLines.push(`**Voice-Call Transcript** \`${header.callId}\``)
  const sec = Math.round(header.durationMs / 1000)
  headerLines.push(
    `Dauer: ${sec}s${header.callerNumber ? ` · Caller: \`${header.callerNumber}\`` : ''}${header.caseType ? ` · Case: \`${header.caseType}\`` : ''}`,
  )
  headerLines.push('')
  if (turns.length === 0) {
    headerLines.push('_(kein Transcript erfasst — möglicherweise Stille oder sehr kurzer Call)_')
    return headerLines.join('\n')
  }
  for (const turn of turns) {
    const tag = turn.who === 'user' ? '🎤 **User**' : '🤖 **Andy**'
    headerLines.push(`${tag}: ${turn.text}`)
  }
  return headerLines.join('\n')
}

/**
 * Split a long markdown string into chunks ≤ DISCORD_CHUNK_LIMIT chars,
 * preserving line breaks. Each chunk gets a `(part N/M)` suffix when the
 * source had to be split.
 */
export function chunkForDiscord(body: string): string[] {
  if (body.length <= DISCORD_CHUNK_LIMIT) return [body]
  const lines = body.split('\n')
  const chunks: string[] = []
  let current = ''
  for (const line of lines) {
    // Single-line longer than chunk limit → hard-split mid-line.
    if (line.length > DISCORD_CHUNK_LIMIT) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      let remaining = line
      while (remaining.length > DISCORD_CHUNK_LIMIT) {
        chunks.push(remaining.slice(0, DISCORD_CHUNK_LIMIT))
        remaining = remaining.slice(DISCORD_CHUNK_LIMIT)
      }
      current = remaining
      continue
    }
    if ((current.length + line.length + 1) > DISCORD_CHUNK_LIMIT) {
      chunks.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current) chunks.push(current)
  // Add part counter when split.
  if (chunks.length > 1) {
    return chunks.map(
      (c, i) => `${c}\n_(part ${i + 1}/${chunks.length})_`,
    )
  }
  return chunks
}

export interface PostCallTranscriptOpts {
  callId: string
  durationMs: number
  callerNumber?: string
  caseType?: string
  channelId: string
  nanoclawMcp: Pick<NanoclawMcpClient, 'sendDiscord'>
  log: Logger
  voiceTraceDir?: string
}

/**
 * Read JSONL → format markdown → chunk → POST each chunk via
 * voice_send_discord_message MCP tool. Fire-and-forget caller — never throws,
 * always logs the outcome.
 */
export async function postCallTranscript(
  opts: PostCallTranscriptOpts,
): Promise<void> {
  const turns = extractTurnsFromJsonl(opts.callId, opts.voiceTraceDir)
  if (turns.length === 0) {
    opts.log.info({
      event: 'post_call_transcript_empty',
      call_id: opts.callId,
      reason: 'no_turns',
    })
    // Still post the header — useful to know the call happened.
  }
  const body = formatTranscript(
    {
      callId: opts.callId,
      durationMs: opts.durationMs,
      callerNumber: opts.callerNumber,
      caseType: opts.caseType,
    },
    turns,
  )
  const chunks = chunkForDiscord(body)
  let posted = 0
  for (const chunk of chunks) {
    try {
      await opts.nanoclawMcp.sendDiscord({
        channel: opts.channelId,
        content: chunk,
        call_id: opts.callId,
      })
      posted++
    } catch (err) {
      opts.log.warn({
        event: 'post_call_transcript_chunk_failed',
        call_id: opts.callId,
        chunk_index: posted,
        chunk_count: chunks.length,
        err: (err as Error)?.message,
      })
      break // Don't keep hammering on persistent failures.
    }
  }
  opts.log.info({
    event: 'post_call_transcript_done',
    call_id: opts.callId,
    turn_count: turns.length,
    chunk_count: chunks.length,
    posted,
    channel: opts.channelId,
  })
}

// Re-export for tests.
export { DISCORD_CHUNK_LIMIT, DISCORD_CONTENT_HARD_LIMIT }
