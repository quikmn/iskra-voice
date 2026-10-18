// Recording a call (PROTOCOL.md "Recording a voice channel"). The server keeps the "Recording" mark (in voice.state)
// and decides who may record; everyone sees the mark, joins a recorded call muted with a notice, and can say "don't
// record me". The recorder's desktop app does the recording: a file per person plus an optional mix, written by the
// shell into a folder on that computer. Who is in it follows the server's voice state; leaving people out is done
// here, on the recorder's side (a courtesy between honest apps, and the app says so).
import { create } from 'zustand'
import type { RemoteTrackPublication } from 'livekit-client'
import type { CallRecording, Events, Welcome } from '../core/protocol'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import { desktop, type RecordingsBridge } from '../platform/desktop'
import { log } from '../core/log'
import { lk } from './livekit'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { activeRoom, rawMicTrack, toggleMute, useVoice, type VoiceSession } from './voice'
import { playTone } from './notify'
import { CallRecorder, recordingSupported, type RecordSink, type WantedTrack } from './recording/recorder'
import { infoText, isRecorded, localStamp, offsetLabel, RECORD_MAX_MS, type RecordedFile } from './recordingLogic'

const KEY = 'iskra.recording'

type Marks = Record<string, Record<number, CallRecording>>

export type RecordErrorKey = 'disk' | 'folder' | 'write' | 'max' | 'desktopOnly'
export type RecordError = string | { key: RecordErrorKey }

export interface RecordNotice {
  serverKey: string
  channelId: number
  /** `joined`: you came into a recorded call (and were muted for it); `started`: it started while you were in. */
  kind: 'joined' | 'started'
  /** We muted you on joining: "OK, unmute" opens your mic again. */
  mutedByUs: boolean
}

interface RecordingState {
  /** Each server's recorded channels, from voice.state. */
  marks: Marks
  /** "Don't record me", on every server (remembered on this device). */
  optOut: boolean
  /** Also save everyone mixed into one file. */
  mixed: boolean
  /** Desktop: where recordings go. */
  folder: string | null
  notice: RecordNotice | null
  /** You're recording: the folder the files go to. */
  local: { serverKey: string; channelId: number; id: string; folder: string; startedAt: number } | null
  busy: boolean
  error: RecordError | null
  /** The last recording you made, to open its folder. */
  saved: { id: string; folder: string } | null
}

function loadPrefs(): { optOut: boolean; mixed: boolean } {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { optOut?: unknown; mixed?: unknown }
    return { optOut: data.optOut === true, mixed: data.mixed !== false }
  } catch {
    return { optOut: false, mixed: true }
  }
}

function savePrefs(): void {
  const { optOut, mixed } = useRecording.getState()
  try {
    localStorage.setItem(KEY, JSON.stringify({ optOut, mixed }))
  } catch {
    /* private mode: this session only */
  }
}

export const useRecording = create<RecordingState>(() => ({
  ...loadPrefs(),
  marks: {},
  folder: null,
  notice: null,
  local: null,
  busy: false,
  error: null,
  saved: null,
}))

/** This app can make recordings (the desktop app); web and phones show the mark but don't record. */
export const canRecordHere = (): boolean => !!desktop?.recordings && recordingSupported()

const NONE = undefined
/** The recording mark of a channel, if any. */
export const useChannelRecording = (serverKey: string, channelId: number): CallRecording | undefined =>
  useRecording((s) => s.marks[serverKey]?.[channelId] ?? NONE)

/** The channel someone is recording on this server, if any (the member list's mark). */
export function useRecordingBy(serverKey: string, accountKey: string): boolean {
  return useRecording((s) => Object.values(s.marks[serverKey] ?? {}).some((m) => m.by === accountKey))
}

/** The voice channel session (not a DM or group call), or null. */
const channelSession = (session: VoiceSession | null): VoiceSession | null => (session && !session.call && !session.group ? session : null)

const me = (serverKey: string): string | null => useApp.getState().servers[serverKey]?.me?.accountKey ?? null

// ── The mark, from the server ────────────────────────────────────────────────

function setMark(serverKey: string, channelId: number, mark: CallRecording | null | undefined): void {
  const before = useRecording.getState().marks[serverKey]?.[channelId]
  if (mark && before && mark.by === before.by && mark.startedAt === before.startedAt && mark.live === before.live) return
  if (!mark && !before) return
  useRecording.setState((s) => {
    const mine = { ...s.marks[serverKey] }
    if (mark) mine[channelId] = mark
    else delete mine[channelId]
    return { marks: { ...s.marks, [serverKey]: mine } }
  })
  const session = channelSession(useVoice.getState().session)
  if (session?.serverKey !== serverKey || session.channelId !== channelId) return
  const notice = useRecording.getState().notice
  if (!mark) {
    if (notice?.serverKey === serverKey && notice.channelId === channelId) useRecording.setState({ notice: null })
  } else if (!before && mark.by !== me(serverKey)) {
    // It started while you're in: a sound and the notice (your mic stays as it was).
    playTone('record')
    useRecording.setState({ notice: { serverKey, channelId, kind: 'started', mutedByUs: false } })
  }
}

onWelcomeHook((serverKey, welcome: Welcome) => {
  const marks: Record<number, CallRecording> = {}
  for (const v of welcome.voice ?? []) if (v.recording) marks[v.channelId] = v.recording
  useRecording.setState((s) => ({ marks: { ...s.marks, [serverKey]: marks } }))
  // "Don't record me" lives on the server only while it runs: say it again on every connect.
  if (useRecording.getState().optOut) {
    setTimeout(() => void connectionFor(serverKey)?.request('voice.record.optout', { optOut: true }).catch(() => undefined), 0)
  }
  follow()
})

onServerEvent((serverKey, type, body) => {
  if (type === 'voice.state') {
    const state = body as Events['voice.state']
    if ('recording' in state) setMark(serverKey, state.channelId, state.recording)
    follow()
  } else if (type === 'voice.available' && !(body as Events['voice.available']).available) {
    useRecording.setState((s) => ({ marks: { ...s.marks, [serverKey]: {} } })) // every call ended
    follow()
  }
})

// Joining a recorded call: muted, with the notice, before the mic can open (connect() publishes the mic muted).
useVoice.subscribe((state, prev) => {
  const session = channelSession(state.session)
  const before = channelSession(prev.session)
  if (session && (session.serverKey !== before?.serverKey || session.channelId !== before?.channelId)) {
    const mark = useRecording.getState().marks[session.serverKey]?.[session.channelId]
    if (mark && mark.by !== me(session.serverKey)) {
      const mutedByUs = !state.muted
      if (mutedByUs) useVoice.setState({ muted: true })
      playTone('record')
      useRecording.setState({ notice: { serverKey: session.serverKey, channelId: session.channelId, kind: 'joined', mutedByUs } })
    } else {
      useRecording.setState({ notice: null })
    }
  } else if (!session && useRecording.getState().notice) {
    useRecording.setState({ notice: null })
  }
  if (state.session !== prev.session) follow()
})

// ── What you can do ──────────────────────────────────────────────────────────

export const clearRecordingError = (): void => useRecording.setState({ error: null })
export const dismissRecordingNotice = (): void => useRecording.setState({ notice: null })
export const dismissSaved = (): void => useRecording.setState({ saved: null })

/** "OK, unmute": the notice goes and your mic opens (if we muted it for the notice). */
export async function unmuteAfterNotice(): Promise<void> {
  const notice = useRecording.getState().notice
  useRecording.setState({ notice: null })
  if (notice?.mutedByUs && useVoice.getState().muted) await toggleMute()
}

/** "Don't record me" (or back in), on every server you're connected to. */
export function setOptOut(optOut: boolean): void {
  useRecording.setState({ optOut })
  savePrefs()
  for (const serverKey of Object.keys(useApp.getState().servers)) {
    void connectionFor(serverKey)?.request('voice.record.optout', { optOut }).catch(() => undefined)
  }
}

export function setMixed(mixed: boolean): void {
  useRecording.setState({ mixed })
  savePrefs()
}

/** Encrypted channels: your answer to being recorded. */
export async function answerRecording(agree: boolean): Promise<void> {
  const session = channelSession(useVoice.getState().session)
  if (!session) return
  try {
    await connectionFor(session.serverKey)?.request('voice.record.consent', { channelId: session.channelId, agree })
  } catch (e) {
    useRecording.setState({ error: errorMessage(e) })
  }
}

/** Desktop: the recordings folder, for the start dialog. */
export async function loadRecordingFolder(): Promise<void> {
  const folder = await desktop?.recordings?.folder().catch(() => null)
  if (folder) useRecording.setState({ folder })
}

export async function pickRecordingFolder(): Promise<void> {
  const folder = await desktop?.recordings?.pickFolder().catch(() => null)
  if (folder) useRecording.setState({ folder })
}

/** Starts recording the voice channel you're in (encrypted channels ask everyone first; recording starts once they agree). */
export async function startRecording(): Promise<boolean> {
  const session = channelSession(useVoice.getState().session)
  if (!session || useRecording.getState().busy) return false
  if (!canRecordHere()) {
    useRecording.setState({ error: { key: 'desktopOnly' } })
    return false
  }
  useRecording.setState({ busy: true, error: null, saved: null })
  try {
    const { recording } = await connectionFor(session.serverKey)!.request('voice.record.start', { channelId: session.channelId })
    setMark(session.serverKey, session.channelId, recording)
    follow()
    return true
  } catch (e) {
    useRecording.setState({ error: errorMessage(e) })
    return false
  } finally {
    useRecording.setState({ busy: false })
  }
}

/** Stops it (yours, or someone else's if you may record here). The files are finished either way. */
export async function stopRecording(): Promise<void> {
  const session = channelSession(useVoice.getState().session)
  if (!session) return
  useRecording.setState({ busy: true })
  try {
    await connectionFor(session.serverKey)?.request('voice.record.stop', { channelId: session.channelId })
    setMark(session.serverKey, session.channelId, null)
  } catch (e) {
    useRecording.setState({ error: errorMessage(e) })
  } finally {
    useRecording.setState({ busy: false })
    follow()
  }
}

export function showRecordingFolder(): void {
  const saved = useRecording.getState().saved ?? useRecording.getState().local
  if (saved) void desktop?.recordings?.show(saved.id).catch(() => undefined)
}

// ── Recording on this device ─────────────────────────────────────────────────

let recorder: CallRecorder | null = null
let starting = false
let ticker: ReturnType<typeof setInterval> | null = null
let unbindRoom: (() => void) | null = null
/** The details for info.txt, kept from the start (names can change during the call). */
let about: { server: string; channel: string; by: string; encrypted: boolean; at: number } | null = null

/** After any change to the session or the marks: start or end recording here, and follow who's in it. */
function follow(): void {
  const session = channelSession(useVoice.getState().session)
  const { local, marks } = useRecording.getState()
  const mark = session ? marks[session.serverKey]?.[session.channelId] : undefined
  const mine = !!session && !!mark && mark.live && mark.by === me(session.serverKey)
  if (local && (!mine || session!.serverKey !== local.serverKey || session!.channelId !== local.channelId)) {
    void finish()
    return
  }
  if (mine && !local && !recorder && !starting && session!.state === 'connected') void begin(session!, mark!)
  else if (recorder) syncTracks()
}

function sinkFor(bridge: RecordingsBridge, id: string): RecordSink {
  return {
    open: (name) => bridge.open(id, name).catch(() => null),
    write: (file, data) => bridge.write(file, data).catch(() => 'failed' as const),
    close: (file) => bridge.close(file).catch(() => false),
  }
}

async function begin(session: VoiceSession, mark: CallRecording): Promise<void> {
  const bridge = desktop?.recordings
  if (!bridge || !recordingSupported()) {
    // The mark is yours but this app can't record (you started it on the desktop, then opened the web app?): end it.
    useRecording.setState({ error: { key: 'desktopOnly' } })
    void connectionFor(session.serverKey)?.request('voice.record.stop', { channelId: session.channelId }).catch(() => undefined)
    return
  }
  starting = true
  try {
    const server = useApp.getState().servers[session.serverKey]
    const channelName = server?.channels.find((c) => c.id === session.channelId)?.name ?? t('recording.info.voice')
    const begun = await bridge.begin(server?.name ?? 'Iskra', channelName).catch(() => null)
    if (!begun || 'error' in begun) {
      await fail(begun && 'error' in begun ? begun.error : 'folder', session)
      return
    }
    const rec = new CallRecorder(sinkFor(bridge, begun.id), { mixed: useRecording.getState().mixed, onFail: (why) => void fail(why, session) })
    await rec.begin()
    about = {
      server: server?.name ?? '', channel: channelName, by: server?.members[mark.by]?.name ?? t('common.someone'), encrypted: mark.encrypted, at: Date.now(),
    }
    recorder = rec
    useRecording.setState({ local: { serverKey: session.serverKey, channelId: session.channelId, id: begun.id, folder: begun.folder, startedAt: rec.startedAt } })
    log('INFO', 'voice', 'record-start', null, [['chan', session.channelId], ['mode', mark.encrypted ? 'e2ee' : 'plain']])
    unbindRoom = bindRoom()
    ticker = setInterval(tick, 2000)
    syncTracks()
    void writeInfo()
  } finally {
    starting = false
  }
  follow() // the mark may have gone meanwhile
}

/** Writing failed, the disk is full, or the time is up: stop here, end the mark, say why. */
async function fail(why: RecordErrorKey, session: VoiceSession): Promise<void> {
  log('WARN', 'voice', 'record-stop', 'VOI-190', [['why', why]])
  useRecording.setState({ error: { key: why } })
  await finish()
  void connectionFor(session.serverKey)?.request('voice.record.stop', { channelId: session.channelId }).catch(() => undefined)
}

async function finish(): Promise<void> {
  const rec = recorder
  const local = useRecording.getState().local
  recorder = null
  if (ticker) clearInterval(ticker)
  ticker = null
  unbindRoom?.()
  unbindRoom = null
  if (!rec || !local) {
    useRecording.setState({ local: null })
    return
  }
  const files = await rec.stop()
  await writeInfo(rec, files, Date.now())
  await desktop?.recordings?.end(local.id).catch(() => undefined)
  log('INFO', 'voice', 'record-end', null, [['chan', local.channelId], ['n', files.length], ['dur', `${Math.round((Date.now() - rec.startedAt) / 1000)}s`]])
  about = null
  useRecording.setState({ local: null, saved: { id: local.id, folder: local.folder } })
}

function tick(): void {
  const rec = recorder
  const session = channelSession(useVoice.getState().session)
  if (!rec || !session) return
  if (Date.now() - rec.startedAt >= RECORD_MAX_MS) {
    void fail('max', session)
    return
  }
  syncTracks()
  void writeInfo()
}

/** The LiveKit room's audio comes and goes: follow it at once (the ticker catches anything missed). */
function bindRoom(): () => void {
  const room = activeRoom()
  if (!room) return () => undefined
  const { RoomEvent } = lk()
  const events = [RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ParticipantDisconnected] as const
  for (const e of events) room.on(e, syncTracks)
  return () => {
    for (const e of events) room.off(e, syncTracks)
  }
}

/** Everyone who should be in the recording right now, and their audio. */
function syncTracks(): void {
  const rec = recorder
  const session = channelSession(useVoice.getState().session)
  const room = activeRoom()
  if (!rec || !session || !room) return
  const server = useApp.getState().servers[session.serverKey]
  const mark = useRecording.getState().marks[session.serverKey]?.[session.channelId]
  if (!server) return
  const recorded = new Set((server.voice[session.channelId] ?? []).filter((p) => isRecorded(p, mark)).map((p) => p.accountKey))
  const name = (key: string) => server.members[key]?.name ?? t('common.someone')
  const { Track } = lk()
  const wanted: WantedTrack[] = []
  const self = server.me?.accountKey
  const mic = rawMicTrack()
  if (self && mic && recorded.has(self)) wanted.push({ accountKey: self, who: name(self), track: mic })
  for (const p of room.remoteParticipants.values()) {
    if (!recorded.has(p.identity)) continue
    for (const pub of p.audioTrackPublications.values() as IterableIterator<RemoteTrackPublication>) {
      if (!pub.isSubscribed || !pub.track) continue
      const screen = pub.source === Track.Source.ScreenShareAudio
      wanted.push({ accountKey: p.identity, who: screen ? t('recording.info.screenAudio', { name: name(p.identity) }) : name(p.identity), track: pub.track.mediaStreamTrack })
    }
  }
  void rec.setTracks(wanted)
}

/** info.txt: who, when, which files (written as it goes, so a crash still leaves it). */
async function writeInfo(rec: CallRecorder | null = recorder, files?: RecordedFile[], endedAt?: number): Promise<void> {
  const local = useRecording.getState().local
  if (!rec || !local || !about) return
  const list = files ?? rec.recorded
  const length = (endedAt ?? Date.now()) - rec.startedAt
  const text = infoText({
    title: t('recording.info.title'),
    server: t('recording.info.server', { name: about.server }),
    channel: t('recording.info.channel', { name: about.channel }),
    by: t('recording.info.by', { name: about.by }),
    started: t('recording.info.started', { time: localStamp(rec.startedAt) }),
    length: endedAt ? t('recording.info.length', { time: offsetLabel(length) }) : t('recording.info.ongoing', { time: offsetLabel(length) }),
    encrypted: about.encrypted ? t('recording.info.encrypted') : '',
    files: t('recording.info.files'),
    mixed: rec.hasMix ? t('recording.info.mixed') : '',
    fileLine: (f) => f.to === null
      ? t('recording.info.fileOpen', { file: f.file, from: offsetLabel(f.from) })
      : t('recording.info.file', { file: f.file, from: offsetLabel(f.from), to: offsetLabel(f.to) }),
    notes: [t('recording.info.offsets'), t('recording.info.consent'), t('recording.info.local')],
  }, list)
  await desktop?.recordings?.info(local.id, text).catch(() => false)
}

// The server's voice state or the members changed (someone opted out, joined, answered): follow it.
useApp.subscribe((state, prev) => {
  const local = useRecording.getState().local
  if (local && state.servers[local.serverKey]?.voice !== prev.servers[local.serverKey]?.voice) syncTracks()
})
