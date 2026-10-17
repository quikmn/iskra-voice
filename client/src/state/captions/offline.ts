// Transcribing a whole recording (a voice message) rather than a live voice: Silero VAD finds the speech, and the
// phrases are packed into as few Whisper windows (up to 30 s each) as they fit, since every window costs about the
// same however much speech is in it. Pure (tested in captions.test.ts); runs in the captions worker.
import { FRAME, SpeechSegmenter } from './segments'

const RATE = 16000
/** Whisper hears up to 30 s at once: a little room to spare. */
export const MAX_WINDOW = 28 * RATE
/** Quiet put between packed phrases, so words don't run together. */
const GAP = Math.round(0.25 * RATE)

/** The speech in `audio` (16 kHz mono), as phrases; `probability` is the VAD's speech probability for a 512-sample frame. */
export function phrasesOf(audio: Float32Array, probability: (frame: Float32Array) => number): Float32Array[] {
  const segmenter = new SpeechSegmenter({ maxMs: 20000, hangoverMs: 600, minSpeechMs: 250 })
  const frame = new Float32Array(FRAME)
  const out: Float32Array[] = []
  for (let i = 0; i < audio.length; i += FRAME) {
    frame.fill(0)
    frame.set(audio.subarray(i, Math.min(audio.length, i + FRAME)))
    const phrase = segmenter.push(frame, probability(frame))
    if (phrase) out.push(phrase)
  }
  const last = segmenter.flush()
  if (last) out.push(last)
  return out
}

/** Phrases joined (with a short gap) into windows of at most `max` samples; a longer phrase is split. */
export function packPhrases(phrases: Float32Array[], max = MAX_WINDOW): Float32Array[] {
  const windows: Float32Array[] = []
  let parts: Float32Array[] = []
  let length = 0
  const close = () => {
    if (!parts.length) return
    const out = new Float32Array(length)
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    windows.push(out)
    parts = []
    length = 0
  }
  for (const phrase of phrases) {
    for (let start = 0; start < phrase.length; start += max) {
      const piece = phrase.subarray(start, Math.min(phrase.length, start + max))
      const gap = parts.length ? GAP : 0
      if (length + gap + piece.length > max) close()
      if (parts.length) {
        parts.push(new Float32Array(GAP))
        length += GAP
      }
      parts.push(piece)
      length += piece.length
    }
  }
  close()
  return windows
}
