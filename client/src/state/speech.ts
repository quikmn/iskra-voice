// Reading messages aloud with the device's own speech synthesis (speechSynthesis: the OS voices on Windows, macOS and
// iOS, speech-dispatcher on Linux; Android's web view has none, so it's hidden there). "Read aloud" on a message,
// "Read new messages aloud" per channel, and /tts messages for people who turned "Play /tts messages" on. Nothing is
// sent anywhere: the text never leaves the device. New messages are read only in the conversation you have open, never
// while it's muted, in quiet hours, with do not disturb or in streamer mode, and reading stops when you switch.
// Screen readers already read new messages; with one running, leave "Read new messages aloud" off (it can't be told
// from a web page) so nothing is heard twice.
import { create } from 'zustand'
import type { Message } from '../core/protocol'
import { currentLanguage, t } from '../i18n'
import { plainText } from '../ui/markdown'
import { heardHooks, quietRules } from './notify'
import { notifyFor } from './organize'
import { has } from './permissions'
import { isDoNotDisturb } from './presence'
import { rolesFor } from './roles'
import { baseRolesFor } from './baseRoles'
import { activeChannelId, useApp, type ServerState } from './store'
import { streamerOn } from './streamer'
import { parseSpeechSettings, shouldRead, withReadAloud, type SpeechSettings } from './speech/speechRules'
import { speakableText, speakCustomEmoji, type SpeechWords } from './speech/speechText'

const KEY = 'iskra.speech'
/** Waiting to be read at most; older ones are dropped when a busy channel outruns the voice. */
const MAX_QUEUE = 5

interface SpeechState {
  settings: SpeechSettings
  /** What's being read right now (a message's key, see speechKey), or null. */
  speaking: string | null
  voices: { uri: string; name: string; lang: string }[]
}

function load(): SpeechSettings {
  try {
    return parseSpeechSettings(localStorage.getItem(KEY))
  } catch {
    return parseSpeechSettings(null)
  }
}

export const useSpeech = create<SpeechState>(() => ({ settings: load(), speaking: null, voices: [] }))

export function updateSpeech(patch: Partial<SpeechSettings>): void {
  const settings = { ...useSpeech.getState().settings, ...patch }
  useSpeech.setState({ settings })
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* private mode: this session only */
  }
}

export const speechSupported = () =>
  typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function'

export const speechKey = (serverKey: string, message: Pick<Message, 'channelId' | 'id'>) => `${serverKey}:${message.channelId}:${message.id}`
const convOf = (serverKey: string, channelId: number) => `c:${serverKey}:${channelId}`

export const useReadAloudHere = (serverKey: string, channelId: number) =>
  useSpeech((s) => s.settings.readAloud.includes(convOf(serverKey, channelId)))

export function setReadAloudHere(serverKey: string, channelId: number, on: boolean): void {
  updateSpeech({ readAloud: withReadAloud(useSpeech.getState().settings.readAloud, convOf(serverKey, channelId), on) })
  if (!on) stopSpeaking()
}

// ── Voices ───────────────────────────────────────────────────────────────

function refreshVoices(): void {
  if (!speechSupported()) return
  const voices = window.speechSynthesis.getVoices().map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang }))
  useSpeech.setState({ voices })
}

if (speechSupported()) {
  refreshVoices()
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices)
}

// ── Speaking ─────────────────────────────────────────────────────────────

interface Line {
  key: string
  text: string
}

const queue: Line[] = []
let current: SpeechSynthesisUtterance | null = null

function next(): void {
  current = null
  const line = queue.shift()
  if (!line) {
    useSpeech.setState({ speaking: null })
    return
  }
  const { settings } = useSpeech.getState()
  const utterance = new SpeechSynthesisUtterance(line.text)
  const voice = settings.voice ? window.speechSynthesis.getVoices().find((v) => v.voiceURI === settings.voice) : undefined
  if (voice) utterance.voice = voice
  utterance.lang = voice?.lang ?? (currentLanguage() === 'sv' ? 'sv-SE' : 'en-US')
  utterance.rate = settings.rate
  utterance.volume = settings.volume
  const done = () => {
    if (current === utterance) next()
  }
  utterance.onend = done
  utterance.onerror = done
  current = utterance
  useSpeech.setState({ speaking: line.key })
  try {
    window.speechSynthesis.speak(utterance)
  } catch {
    done()
  }
}

function say(line: Line, interrupt: boolean): void {
  if (!speechSupported()) return
  if (interrupt) stopSpeaking()
  queue.push(line)
  while (queue.length > MAX_QUEUE) queue.shift()
  if (!current) next()
}

/** Stops reading and forgets what was waiting. */
export function stopSpeaking(): void {
  queue.length = 0
  const was = current
  current = null
  if (was || useSpeech.getState().speaking) useSpeech.setState({ speaking: null })
  if (speechSupported()) {
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* nothing to stop */
    }
  }
}

/** A sample in the chosen voice, speed and volume (Settings). */
export function testVoice(): void {
  say({ key: 'test', text: t('speech.read.sample') }, true)
}

function words(): SpeechWords {
  return {
    codeBlock: (lines) => t('speech.read.codeBlock', { count: lines }),
    spoiler: t('speech.read.spoiler'),
    link: (host) => t('speech.read.link', { host }),
    more: t('speech.read.more'),
  }
}

/** A message as it's read: the author (unless `bare`), then the words. Empty when there's nothing to say. */
export function spokenMessage(server: ServerState, message: Message, bare = false): string {
  const roles = rolesFor(server.key)
  const plain = plainText(speakCustomEmoji(message.text ?? ''), {
    nameOf: (k) => server.members[k]?.name ?? null,
    roleOf: (id) => {
      const role = roles.find((r) => r.id === id)
      return role ? { name: role.name, color: role.color, mine: false } : null
    },
  })
  let text = speakableText(plain, words())
  if (!text && (message as { voice?: unknown }).voice) text = t('speech.read.voiceMessage')
  if (!text) return ''
  if (bare) return text
  const author = (message as { webhook?: { name: string } | null }).webhook?.name ?? server.members[message.author]?.name ?? t('common.someone')
  return t('speech.read.says', { name: author, text })
}

/** "Read aloud" on a message: reads it now (again: stops). */
export function readMessageAloud(server: ServerState, message: Message): void {
  const key = speechKey(server.key, message)
  if (useSpeech.getState().speaking === key) return stopSpeaking()
  const text = spokenMessage(server, message, true)
  if (text) say({ key, text }, true)
}

/** Messages already read (a reconnect may hand the same one over twice). */
const read = new Set<string>()

/** Every new message from someone else (state/notify.ts calls this, after blocks): read it if your settings say so. */
function heard(serverKey: string, message: Message): void {
  if (!speechSupported()) return
  const { settings } = useSpeech.getState()
  const conv = convOf(serverKey, message.channelId)
  const readAloudHere = settings.readAloud.includes(conv)
  if (!readAloudHere && !(settings.playTts && message.tts)) return
  const state = useApp.getState()
  const server = state.servers[serverKey]
  if (!server) return
  const author = server.members[message.author]
  // The server checks the permission for plain messages; inside encryption only the app can.
  const ttsAllowed = !!message.tts && has(author, rolesFor(serverKey), 'sendTts', baseRolesFor(serverKey))
  const notify = notifyFor(serverKey, message.channelId)
  // The channel you have open; /tts only while the app shows (reading aloud also goes on behind a game).
  const here = state.activeServer === serverKey && activeChannelId(state) === message.channelId
  const open = here && (readAloudHere || document.visibilityState !== 'hidden')
  const hushed = !!quietRules.now() || isDoNotDisturb() || streamerOn()
  if (!shouldRead({ readAloudHere, tts: ttsAllowed, playTts: settings.playTts, open, muted: notify.muted || notify.chosen === 'none', hushed })) return
  const key = speechKey(serverKey, message)
  if (read.has(key)) return
  read.add(key)
  if (read.size > 500) read.delete(read.values().next().value!)
  const text = spokenMessage(server, message)
  if (text) say({ key, text }, false)
}

heardHooks.push(heard)

// Switching to another conversation (or server) stops reading.
useApp.subscribe((s, prev) => {
  if (s.activeServer !== prev.activeServer || activeChannelId(s) !== activeChannelId(prev)) {
    if (current || queue.length) stopSpeaking()
  }
})

// ── /tts ─────────────────────────────────────────────────────────────────

export { parseTtsCommand } from './speech/speechRules'

/** Why "/tts <text>" can't be sent here (null: it can). The server checks too (plain channels). */
export function ttsBlocked(serverKey: string, text: string): string | null {
  const server = useApp.getState().servers[serverKey]
  if (!text) return t('speech.tts.empty')
  if (!has(server?.me, rolesFor(serverKey), 'sendTts', baseRolesFor(serverKey))) return t('errors.server.tts_forbidden')
  return null
}
