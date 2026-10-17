// When a new message is read aloud by itself, and how speech settings are kept. Pure (tested in speechText.test.ts).

export interface SpeechSettings {
  /** 0.5–2 (1 is the voice's normal speed). */
  rate: number
  /** 0–1. */
  volume: number
  /** A voice's voiceURI; null: the device's default for the app's language. */
  voice: string | null
  /** Read messages sent with /tts (off by default: they can be annoying). */
  playTts: boolean
  /** Conversations where every new message is read ("c:<serverKey>:<channelId>", see convKey). */
  readAloud: string[]
}

export const SPEECH_DEFAULTS: SpeechSettings = { rate: 1, volume: 1, voice: null, playTts: false, readAloud: [] }
const MAX_CONVS = 200

const clamp = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback

export function parseSpeechSettings(raw: string | null): SpeechSettings {
  try {
    const p = JSON.parse(raw ?? '{}') as Partial<SpeechSettings>
    return {
      rate: clamp(p.rate, 0.5, 2, 1),
      volume: clamp(p.volume, 0, 1, 1),
      voice: typeof p.voice === 'string' && p.voice.length <= 500 ? p.voice : null,
      playTts: p.playTts === true,
      readAloud: Array.isArray(p.readAloud) ? p.readAloud.filter((c): c is string => typeof c === 'string' && c.length <= 200).slice(-MAX_CONVS) : [],
    }
  } catch {
    return { ...SPEECH_DEFAULTS, readAloud: [] }
  }
}

export const withReadAloud = (list: string[], conv: string, on: boolean): string[] =>
  on ? [...list.filter((c) => c !== conv), conv].slice(-MAX_CONVS) : list.filter((c) => c !== conv)

export interface HeardMessage {
  /** "Read new messages aloud" is on in its conversation. */
  readAloudHere: boolean
  /** Sent with /tts, by someone allowed to. */
  tts: boolean
  playTts: boolean
  /** It's in the conversation you have open. */
  open: boolean
  /** Muted, or set to "Nothing". */
  muted: boolean
  /** Quiet hours, do not disturb, or streamer mode. */
  hushed: boolean
}

/** A new message from someone else is read aloud only where you're looking, and never while you asked for quiet. */
export function shouldRead(m: HeardMessage): boolean {
  if (!m.open || m.muted || m.hushed) return false
  return m.readAloudHere || (m.tts && m.playTts)
}

/** "/tts hello" → "hello" ("" for a bare "/tts"); null when the text isn't a /tts command. */
export function parseTtsCommand(text: string): string | null {
  const m = /^\/tts(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return m ? (m[1] ?? '').trim() : null
}
