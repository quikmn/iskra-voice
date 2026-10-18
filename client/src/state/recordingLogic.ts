// Recording a call: the pure parts (who is recorded, who still has to answer, file names, the info.txt). The server
// keeps the mark and the answers; the recorder's desktop app does the recording (state/recording.ts).
import type { CallRecording, VoiceParticipant } from '../core/protocol'

/** The longest recording (the server ends the mark at the same point). */
export const RECORD_MAX_MS = 4 * 60 * 60 * 1000
/** Each person's file and the mix: Opus in WebM, what MediaRecorder makes. */
export const RECORD_MIME = 'audio/webm;codecs=opus'

/** This person's voice goes into the recording right now. */
export function isRecorded(p: VoiceParticipant, rec: CallRecording | null | undefined): boolean {
  if (!rec?.live || p.noRecord) return false
  return !rec.encrypted || p.recordConsent === true
}

/** Encrypted channels: you're in the call, not the recorder, and haven't answered yet. */
export function needsAnswer(me: string | null | undefined, participants: VoiceParticipant[], rec: CallRecording | null | undefined): boolean {
  if (!me || !rec?.encrypted || rec.by === me) return false
  const mine = participants.find((p) => p.accountKey === me)
  return !!mine && (mine.recordConsent ?? null) === null
}

/** While an encrypted channel is being asked: how many of the people in the call said yes. */
export function answers(participants: VoiceParticipant[]): { yes: number; total: number } {
  return { yes: participants.filter((p) => p.recordConsent === true).length, total: participants.length }
}

/** A name made safe for a file: no folders, nothing Windows refuses, not too long. */
export function safeFileName(name: string, fallback = 'someone'): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f"*:<>?|/\\]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 60)
  return cleaned || fallback
}

/** "Alex.webm", then "Alex (2).webm" for Alex's next part (or another Alex). */
export function trackFileName(name: string, taken: Set<string>): string {
  const base = safeFileName(name)
  for (let n = 1; ; n++) {
    const file = n === 1 ? `${base}.webm` : `${base} (${n}).webm`
    if (!taken.has(file.toLowerCase()) && file.toLowerCase() !== 'mixed.webm') return file
  }
}

/** 0:00:12, 1:02:03: where a file starts and ends in the recording. */
export function offsetLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
}

/** One file in the recording: whose voice, from when to when (ms after the start). */
export interface RecordedFile {
  file: string
  who: string
  from: number
  to: number | null
}

export interface InfoWords {
  title: string
  server: string
  channel: string
  by: string
  started: string
  length: string
  encrypted: string
  files: string
  mixed: string
  fileLine: (file: RecordedFile) => string
  notes: string[]
}

/** The info.txt next to the files: who, when, which tracks (in the app's language, worded by the caller). */
export function infoText(words: InfoWords, files: RecordedFile[]): string {
  const lines = [
    words.title,
    '',
    words.server,
    words.channel,
    words.by,
    words.started,
    words.length,
    ...(words.encrypted ? [words.encrypted] : []),
    '',
    words.files,
    ...(words.mixed ? [`- ${words.mixed}`] : []),
    ...files.map((f) => `- ${words.fileLine(f)}`),
    '',
    ...words.notes,
  ]
  return lines.join('\n') + '\n'
}

/** A date for the folder and the info file, in local time: 2026-10-18 21:05:09. */
export function localStamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
