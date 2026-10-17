import { describe, expect, it } from 'vitest'
import { FRAME } from '../captions/segments'
import { MAX_WINDOW, packPhrases, phrasesOf } from '../captions/offline'
import { cacheFor } from '../transcripts'
import { isEncryptedKey, MAX_TEXT, memoryCache, transcriptKey } from './transcriptCache'

describe('transcript cache', () => {
  it('keys channel and encrypted voice messages apart', () => {
    expect(transcriptKey.file('srv', 'f1')).toBe('f:srv:f1')
    expect(transcriptKey.encrypted('srv', 'f1')).toBe('e:srv:f1')
    expect(isEncryptedKey(transcriptKey.encrypted('srv', 'f1'))).toBe(true)
    expect(isEncryptedKey(transcriptKey.file('srv', 'f1'))).toBe(false)
  })

  it('keeps encrypted transcripts in memory only, never in the disk cache', async () => {
    const fakeDb = { open: () => { throw new Error('the disk must not be touched') } }
    const g = globalThis as { indexedDB?: unknown }
    const had = g.indexedDB
    g.indexedDB = fakeDb
    try {
      const encrypted = cacheFor(transcriptKey.encrypted('srv', 'x'))
      await encrypted.put('e:srv:x', { text: 'secret words', at: 1 })
      expect(await encrypted.get('e:srv:x')).toEqual({ text: 'secret words', at: 1 })
      expect(cacheFor(transcriptKey.file('srv', 'y'))).not.toBe(encrypted)
    } finally {
      g.indexedDB = had
    }
  })

  it('remembers, refreshes and drops the oldest past its limit', async () => {
    const cache = memoryCache(2)
    await cache.put('a', { text: 'one', at: 1 })
    await cache.put('b', { text: 'two', at: 2 })
    await cache.put('a', { text: 'one again', at: 3 })
    await cache.put('c', { text: 'three', at: 4 })
    expect(await cache.get('b')).toBeNull()
    expect((await cache.get('a'))?.text).toBe('one again')
    expect((await cache.get('c'))?.text).toBe('three')
    await cache.put('d', { text: 'x'.repeat(MAX_TEXT + 50), at: 5 })
    expect((await cache.get('d'))?.text.length).toBe(MAX_TEXT)
  })
})

describe('whole recordings', () => {
  const RATE = 16000
  /** `pattern`: seconds of speech (true) or quiet (false). */
  function recording(pattern: [boolean, number][]): { audio: Float32Array; speech: (frame: Float32Array) => number } {
    const total = pattern.reduce((n, [, s]) => n + s * RATE, 0)
    const audio = new Float32Array(total)
    let o = 0
    for (const [talking, seconds] of pattern) {
      if (talking) audio.fill(0.5, o, o + seconds * RATE)
      o += seconds * RATE
    }
    return { audio, speech: (frame) => (frame[0] > 0.25 ? 0.9 : 0.05) }
  }

  it('finds the phrases and leaves the quiet out', () => {
    const { audio, speech } = recording([[false, 1], [true, 2], [false, 2], [true, 3], [false, 1]])
    const phrases = phrasesOf(audio, speech)
    expect(phrases).toHaveLength(2)
    expect(phrases[0].length / RATE).toBeGreaterThan(1.9)
    expect(phrases[1].length / RATE).toBeGreaterThan(2.9)
    expect(phrasesOf(new Float32Array(RATE * 3), speech)).toHaveLength(0)
  })

  it('keeps speech that runs to the very end', () => {
    const { audio, speech } = recording([[false, 0.5], [true, 2.01]])
    const phrases = phrasesOf(audio, speech)
    expect(phrases).toHaveLength(1)
    expect(phrases[0].length).toBeGreaterThan(2 * RATE)
    expect(phrases[0].length % FRAME).toBe(0)
  })

  it('packs phrases into as few Whisper windows as fit', () => {
    const second = (n: number) => new Float32Array(n * RATE)
    expect(packPhrases([second(5), second(5), second(5)])).toHaveLength(1)
    const windows = packPhrases([second(20), second(10), second(3)])
    expect(windows).toHaveLength(2)
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(MAX_WINDOW)
    // A phrase longer than a window is split.
    const long = packPhrases([second(60)])
    expect(long.length).toBe(3)
    expect(long.reduce((n, w) => n + w.length, 0)).toBe(60 * RATE)
    expect(packPhrases([])).toEqual([])
  })
})
