import { describe, expect, it } from 'vitest'
import type { CallRecording, VoiceParticipant } from '../../core/protocol'
import { answers, infoText, isRecorded, needsAnswer, offsetLabel, olderApp, recordedNow, safeFileName, trackFileName } from '../recordingLogic'
import { CallRecorder, type RecorderLike, type RecordSink, type WantedTrack } from './recorder'

const p = (accountKey: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant => ({ accountKey, muted: false, deafened: false, recordingAware: true, ...extra })
const plain: CallRecording = { by: 'rec', startedAt: 1, live: true, encrypted: false }
const encrypted: CallRecording = { by: 'rec', startedAt: 1, live: true, encrypted: true }

describe('who is recorded', () => {
  it('is everyone but people who said "don\'t record me"; encrypted channels only those who said yes', () => {
    expect(isRecorded(p('a'), plain)).toBe(true)
    expect(isRecorded(p('a', { noRecord: true }), plain)).toBe(false)
    expect(isRecorded(p('a'), null)).toBe(false)
    expect(isRecorded(p('a'), { ...plain, live: false })).toBe(false)
    expect(isRecorded(p('a'), encrypted)).toBe(false)
    expect(isRecorded(p('a', { recordConsent: false }), encrypted)).toBe(false)
    expect(isRecorded(p('a', { recordConsent: true }), encrypted)).toBe(true)
    expect(isRecorded(p('a', { recordConsent: true, noRecord: true }), encrypted)).toBe(false)
  })

  it('never includes apps that do not show the mark (older apps, bots)', () => {
    expect(isRecorded(p('old', { recordingAware: false }), plain)).toBe(false)
    expect(isRecorded({ accountKey: 'old', muted: false, deafened: false }, plain)).toBe(false)
    expect(isRecorded(p('old', { recordingAware: undefined, recordConsent: true }), encrypted)).toBe(false)
    expect(olderApp(p('old', { recordingAware: false }), plain)).toBe(true)
    expect(olderApp(p('new'), plain)).toBe(false)
  })

  it('records nobody while the recorder is offline from the server', () => {
    const people = [p('a'), p('b', { noRecord: true }), p('c', { recordingAware: false })]
    expect([...recordedNow(people, plain, true)]).toEqual(['a'])
    expect([...recordedNow(people, plain, false)]).toEqual([])
  })

  it('asks people in an encrypted call who have not answered (never the recorder)', () => {
    const people = [p('rec', { recordConsent: true }), p('a'), p('b', { recordConsent: false })]
    expect(needsAnswer('a', people, encrypted)).toBe(true)
    expect(needsAnswer('b', people, encrypted)).toBe(false)
    expect(needsAnswer('rec', people, encrypted)).toBe(false)
    expect(needsAnswer('outside', people, encrypted)).toBe(false)
    expect(needsAnswer('a', people, plain)).toBe(false)
    expect(answers(people)).toEqual({ yes: 1, total: 3 })
  })
})

describe('files', () => {
  it('get safe, unique names', () => {
    expect(safeFileName('Al/ex: "the" <best>?')).toBe('Alex the best')
    expect(safeFileName('...')).toBe('someone')
    const taken = new Set<string>()
    const first = trackFileName('Alex', taken)
    taken.add(first.toLowerCase())
    expect(first).toBe('Alex.webm')
    expect(trackFileName('alex', taken)).toBe('alex (2).webm')
    expect(trackFileName('mixed', new Set())).toBe('mixed (2).webm')
  })

  it('note where each starts in info.txt', () => {
    expect(offsetLabel(3_723_000)).toBe('1:02:03')
    expect(offsetLabel(-5)).toBe('0:00:00')
    const text = infoText({
      title: 'T', server: 'S', channel: 'C', by: 'B', started: 'At', length: 'L', encrypted: '', files: 'Files:', mixed: 'mixed.webm',
      fileLine: (f) => `${f.file} ${offsetLabel(f.from)}-${f.to === null ? '' : offsetLabel(f.to)}`, notes: ['n'],
    }, [{ file: 'Alex.webm', who: 'Alex', from: 0, to: 61_000 }, { file: 'Bea.webm', who: 'Bea', from: 5_000, to: null }])
    expect(text).toBe('T\n\nS\nC\nB\nAt\nL\n\nFiles:\n- mixed.webm\n- Alex.webm 0:00:00-0:01:01\n- Bea.webm 0:00:05-\n\nn\n')
  })
})

/** A MediaRecorder stand-in: hands over one chunk a "second" and the last one on stop. */
class FakeRecorder implements RecorderLike {
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  readonly label: string
  constructor(label: string) {
    this.label = label
  }
  start(): void {
    this.state = 'recording'
  }
  tick(): void {
    this.ondataavailable?.({ data: new Blob([this.label]) })
  }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['.']) })
    setTimeout(() => this.onstop?.(), 0)
  }
}

function fakeSink(result: () => 'ok' | 'disk' | 'failed' = () => 'ok') {
  const files = new Map<string, { name: string; bytes: string; closed: boolean }>()
  let n = 0
  const sink: RecordSink = {
    open: async (name) => {
      const id = `f${++n}`
      files.set(id, { name, bytes: '', closed: false })
      return id
    },
    write: async (id, data) => {
      const r = result()
      if (r === 'ok') files.get(id)!.bytes += new TextDecoder().decode(data)
      return r
    },
    close: async (id) => {
      files.get(id)!.closed = true
      return true
    },
  }
  return { sink, files }
}

const track = (id: string) => ({ id, readyState: 'live' } as MediaStreamTrack)
const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('the recorder', () => {
  it('starts a file per person, ends it when they are left out, and starts another when they are back', async () => {
    let now = 1000
    const recorders: FakeRecorder[] = []
    const { sink, files } = fakeSink()
    const failures: string[] = []
    const rec = new CallRecorder(sink, {
      mixed: false, now: () => now, onFail: (why) => failures.push(why),
      makeStream: (tracks) => ({ id: tracks[0].id } as unknown as MediaStream),
      makeRecorder: (stream) => {
        const r = new FakeRecorder((stream as unknown as { id: string }).id)
        recorders.push(r)
        return r
      },
    })
    await rec.begin()
    const alex: WantedTrack = { accountKey: 'a', who: 'Alex', track: track('ta') }
    const bea: WantedTrack = { accountKey: 'b', who: 'Bea', track: track('tb') }
    await rec.setTracks([alex])
    now = 6000
    await rec.setTracks([alex, bea]) // Bea joins 5 s in
    recorders.forEach((r) => r.tick())
    await flush()
    now = 9000
    await rec.setTracks([alex]) // Bea says "don't record me"
    now = 12000
    await rec.setTracks([alex, bea]) // ...and changes her mind
    now = 20000
    const done = await rec.stop()

    expect(done).toEqual([
      { file: 'Alex.webm', who: 'Alex', from: 0, to: 19000 },
      { file: 'Bea.webm', who: 'Bea', from: 5000, to: 8000 },
      { file: 'Bea (2).webm', who: 'Bea', from: 11000, to: 19000 },
    ])
    const byName = Object.fromEntries([...files.values()].map((f) => [f.name, f]))
    expect(byName['Alex.webm']).toEqual({ name: 'Alex.webm', bytes: 'ta.', closed: true })
    expect(byName['Bea.webm']).toEqual({ name: 'Bea.webm', bytes: 'tb.', closed: true })
    expect(byName['Bea (2).webm'].closed).toBe(true)
    expect(failures).toEqual([])
    expect(rec.bytes).toBeGreaterThan(0)
  })

  it('pauses while offline from the server (no file open) and resumes in new files', async () => {
    let now = 0
    const { sink, files } = fakeSink()
    const rec = new CallRecorder(sink, {
      mixed: false, now: () => now, onFail: () => undefined, makeStream: () => ({} as MediaStream), makeRecorder: () => new FakeRecorder('x'),
    })
    await rec.begin()
    const people = [p('a'), p('b')]
    const tracks = (keys: Set<string>) => [...keys].map((k) => ({ accountKey: k, who: k.toUpperCase(), track: track(`t${k}`) }))
    await rec.setTracks(tracks(recordedNow(people, plain, true)))
    now = 5000
    await rec.setTracks(tracks(recordedNow(people, plain, false))) // the connection dropped
    expect([...files.values()].every((f) => f.closed)).toBe(true)
    now = 9000
    await rec.setTracks(tracks(recordedNow([p('a'), p('b', { noRecord: true })], plain, true))) // back: B opted out meanwhile
    const done = await rec.stop()
    expect(done.map((f) => [f.file, f.from, f.to])).toEqual([['A.webm', 0, 5000], ['B.webm', 0, 5000], ['A (2).webm', 9000, 9000]])
  })

  it('mixes everyone into mixed.webm when asked, and stops on a full disk', async () => {
    let full = false
    const { sink, files } = fakeSink(() => (full ? 'disk' : 'ok'))
    const failures: string[] = []
    const mixed: string[] = []
    const recorders: FakeRecorder[] = []
    const rec = new CallRecorder(sink, {
      mixed: true, onFail: (why) => failures.push(why),
      makeStream: () => ({} as MediaStream),
      makeRecorder: () => {
        const r = new FakeRecorder('x')
        recorders.push(r)
        return r
      },
      makeMixer: () => ({ stream: {} as MediaStream, add: (key) => mixed.push(`+${key}`), remove: (key) => mixed.push(`-${key}`), close: () => mixed.push('closed') }),
    })
    await rec.begin()
    expect(rec.hasMix).toBe(true)
    await rec.setTracks([{ accountKey: 'a', who: 'Alex', track: track('ta') }])
    await rec.setTracks([])
    expect(mixed).toEqual(['+a:ta', '-a:ta'])
    full = true
    recorders[0].tick()
    await flush()
    expect(failures).toEqual(['disk'])
    await rec.stop()
    expect(mixed.at(-1)).toBe('closed')
    expect([...files.values()].map((f) => f.name)).toEqual(['mixed.webm', 'Alex.webm'])
  })
})
