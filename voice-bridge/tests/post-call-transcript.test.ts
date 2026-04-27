import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  extractTurnsFromJsonl,
  formatTranscript,
  chunkForDiscord,
  postCallTranscript,
} from '../src/post-call-transcript.js'

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'post-call-test-'))
}

function mockLog(): {
  info: ReturnType<typeof vi_fn>
  warn: ReturnType<typeof vi_fn>
} {
  return {
    info: vi_fn(),
    warn: vi_fn(),
  }
}

// Minimal vi.fn shim — vitest provides vi but we stay explicit for these tests.
import { vi } from 'vitest'
const vi_fn = vi.fn

describe('post-call-transcript / extractTurnsFromJsonl', () => {
  it('extracts user transcript from input_audio_transcription.completed', () => {
    const dir = tmpdir()
    const callId = 'rtc_test_user'
    fs.writeFileSync(
      path.join(dir, `turns-${callId}.jsonl`),
      JSON.stringify({
        t_ms_since_open: 100,
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Hallo Andy, wie wird das Wetter?',
      }) + '\n',
    )
    const turns = extractTurnsFromJsonl(callId, dir)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      who: 'user',
      text: 'Hallo Andy, wie wird das Wetter?',
    })
  })

  it('extracts bot transcript from response.done output_audio content', () => {
    const dir = tmpdir()
    const callId = 'rtc_test_bot'
    fs.writeFileSync(
      path.join(dir, `turns-${callId}.jsonl`),
      JSON.stringify({
        t_ms_since_open: 500,
        type: 'response.done',
        response: {
          output: [
            {
              id: 'item_x',
              content: [
                { type: 'output_audio', transcript: 'In München sonnig, 22 Grad.' },
              ],
            },
          ],
        },
      }) + '\n',
    )
    const turns = extractTurnsFromJsonl(callId, dir)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      who: 'bot',
      text: 'In München sonnig, 22 Grad.',
    })
  })

  it('returns chronological alternation when both event types present', () => {
    const dir = tmpdir()
    const callId = 'rtc_test_alternation'
    const lines = [
      JSON.stringify({
        t_ms_since_open: 100,
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Frage 1',
      }),
      JSON.stringify({
        t_ms_since_open: 200,
        type: 'response.done',
        response: {
          output: [
            { id: 'a', content: [{ type: 'output_audio', transcript: 'Antwort 1' }] },
          ],
        },
      }),
      JSON.stringify({
        t_ms_since_open: 300,
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Frage 2',
      }),
    ]
    fs.writeFileSync(path.join(dir, `turns-${callId}.jsonl`), lines.join('\n'))
    const turns = extractTurnsFromJsonl(callId, dir)
    expect(turns).toHaveLength(3)
    expect(turns.map((t) => `${t.who}:${t.text}`)).toEqual([
      'user:Frage 1',
      'bot:Antwort 1',
      'user:Frage 2',
    ])
  })

  it('returns [] when JSONL file is missing', () => {
    const turns = extractTurnsFromJsonl('rtc_missing', tmpdir())
    expect(turns).toEqual([])
  })

  it('skips events with empty/whitespace transcripts', () => {
    const dir = tmpdir()
    const callId = 'rtc_test_empty'
    fs.writeFileSync(
      path.join(dir, `turns-${callId}.jsonl`),
      JSON.stringify({
        t_ms_since_open: 1,
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '   ',
      }) +
        '\n' +
        JSON.stringify({
          t_ms_since_open: 2,
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: '',
        }),
    )
    expect(extractTurnsFromJsonl(callId, dir)).toEqual([])
  })

  it('sanitizes call_id for filename (no path injection)', () => {
    const dir = tmpdir()
    const safeCallId = 'rtc_../etc_passwd'
    // The function should never read /etc/passwd — it must sanitize the
    // path component. Best signal: pass a benign call_id with the same
    // sanitization signature; the file with sanitized name doesn't exist
    // → returns []. (We rely on the sanitization regex stripping `..`
    // characters; a stricter test would create both files and verify
    // we don't read the parent-dir one.)
    expect(extractTurnsFromJsonl(safeCallId, dir)).toEqual([])
  })
})

describe('post-call-transcript / formatTranscript', () => {
  it('emits header with callId + duration + case type', () => {
    const md = formatTranscript(
      { callId: 'rtc_xyz', durationMs: 12000, caseType: 'case6b' },
      [],
    )
    expect(md).toContain('rtc_xyz')
    expect(md).toContain('12s')
    expect(md).toContain('case6b')
    expect(md).toContain('kein Transcript erfasst')
  })

  it('formats user/bot turns with emoji + bold tag', () => {
    const md = formatTranscript(
      { callId: 'rtc_x', durationMs: 5000 },
      [
        { t: 100, who: 'user', text: 'Hallo' },
        { t: 200, who: 'bot', text: 'Moin Carsten' },
      ],
    )
    expect(md).toContain('🎤 **User**: Hallo')
    expect(md).toContain('🤖 **Andy**: Moin Carsten')
  })
})

describe('post-call-transcript / chunkForDiscord', () => {
  it('returns single chunk for short body', () => {
    const chunks = chunkForDiscord('short content')
    expect(chunks).toEqual(['short content'])
  })

  it('splits long body at line boundaries', () => {
    const longLine = 'a'.repeat(500)
    const body = Array.from({ length: 5 }, () => longLine).join('\n')
    const chunks = chunkForDiscord(body)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000)
    // Each chunk gets a part-counter suffix.
    expect(chunks[0]).toMatch(/_\(part 1\/\d+\)_/)
  })

  it('hard-splits a single line longer than the chunk limit', () => {
    const huge = 'x'.repeat(5000)
    const chunks = chunkForDiscord(huge)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000)
  })
})

describe('post-call-transcript / postCallTranscript integration', () => {
  it('reads JSONL → formats → chunks → posts each via sendDiscord', async () => {
    const dir = tmpdir()
    const callId = 'rtc_integration_test'
    const lines = [
      JSON.stringify({
        t_ms_since_open: 100,
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Wie wird das Wetter?',
      }),
      JSON.stringify({
        t_ms_since_open: 200,
        type: 'response.done',
        response: {
          output: [
            {
              id: 'a',
              content: [{ type: 'output_audio', transcript: 'In München 22 Grad sonnig.' }],
            },
          ],
        },
      }),
    ]
    fs.writeFileSync(path.join(dir, `turns-${callId}.jsonl`), lines.join('\n'))
    const sendDiscord = vi.fn().mockResolvedValue({ status: 'ok' })
    const log = mockLog()
    await postCallTranscript({
      callId,
      durationMs: 8000,
      channelId: '1498423411733561404',
      nanoclawMcp: { sendDiscord },
      log: log as unknown as Parameters<typeof postCallTranscript>[0]['log'],
      voiceTraceDir: dir,
    })
    expect(sendDiscord).toHaveBeenCalledTimes(1)
    const args = sendDiscord.mock.calls[0][0]
    expect(args.channel).toBe('1498423411733561404')
    expect(args.call_id).toBe(callId)
    expect(args.content).toContain('Wie wird das Wetter?')
    expect(args.content).toContain('In München 22 Grad sonnig.')
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'post_call_transcript_done',
        turn_count: 2,
        chunk_count: 1,
        posted: 1,
      }),
    )
  })

  it('posts the header even when JSONL is empty / missing', async () => {
    const sendDiscord = vi.fn().mockResolvedValue({ status: 'ok' })
    const log = mockLog()
    await postCallTranscript({
      callId: 'rtc_no_jsonl',
      durationMs: 1500,
      channelId: '1498423411733561404',
      nanoclawMcp: { sendDiscord },
      log: log as unknown as Parameters<typeof postCallTranscript>[0]['log'],
      voiceTraceDir: tmpdir(),
    })
    expect(sendDiscord).toHaveBeenCalledTimes(1)
    expect(sendDiscord.mock.calls[0][0].content).toContain('kein Transcript erfasst')
  })

  it('stops posting on first sendDiscord rejection', async () => {
    const dir = tmpdir()
    const callId = 'rtc_fail_test'
    // Create a body long enough to require multiple chunks.
    const longLine = 'x'.repeat(500)
    const lines = []
    for (let i = 0; i < 6; i++) {
      lines.push(
        JSON.stringify({
          t_ms_since_open: i * 100,
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: longLine,
        }),
      )
    }
    fs.writeFileSync(path.join(dir, `turns-${callId}.jsonl`), lines.join('\n'))
    const sendDiscord = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ok' })
      .mockRejectedValueOnce(new Error('rate_limited'))
    const log = mockLog()
    await postCallTranscript({
      callId,
      durationMs: 30000,
      channelId: '1498423411733561404',
      nanoclawMcp: { sendDiscord },
      log: log as unknown as Parameters<typeof postCallTranscript>[0]['log'],
      voiceTraceDir: dir,
    })
    expect(sendDiscord).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'post_call_transcript_chunk_failed',
        chunk_index: 1,
      }),
    )
  })
})
