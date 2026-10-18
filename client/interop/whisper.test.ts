// Whisper against a real server and LiveKit: the target hears the whisperer, someone else in the same voice channel
// gets no token and no audio, and a listener who is no longer reached is thrown out of the whisper room by the server
// even with a token they still hold. Run with `npm run test:interop` (LiveKit from .tools: scripts/get-livekit.*).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadRtc } from '../../bots/sdk/src/voice/modules'
import { Connection } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import { buildInviteLink, parseInvite } from '../src/core/invite'
import type { Events, Welcome } from '../src/core/protocol'
import { freePort, freeUdpPort } from './ports'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const LIVEKIT = resolve(__dirname, '../../.tools', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')

async function waitFor<T>(check: () => T | undefined | null | false, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** The parts of LiveKit's Node SDK used here. */
interface Rtc {
  Room: new () => RtcRoom
  AudioSource: new (rate: number, channels: number) => { captureFrame(frame: unknown): Promise<void>; close(): Promise<void> }
  AudioFrame: new (data: Int16Array, rate: number, channels: number, samples: number) => unknown
  AudioStream: new (track: unknown, rate: number, channels: number) => AsyncIterable<{ data: Int16Array }>
  LocalAudioTrack: { createAudioTrack(name: string, source: unknown): unknown }
  TrackPublishOptions: new (data: { source: number }) => unknown
  TrackSource: { SOURCE_MICROPHONE: number }
}
interface RtcRoom {
  localParticipant?: { publishTrack(track: unknown, options: unknown): Promise<unknown> }
  connect(url: string, token: string, opts: { autoSubscribe: boolean; dynacast: boolean }): Promise<void>
  disconnect(): Promise<void>
  on(event: 'trackSubscribed', listener: (track: unknown, publication: unknown, participant: { identity: string }) => void): unknown
  on(event: 'disconnected', listener: (reason: number) => void): unknown
}

interface Person {
  name: string
  connection: Connection
  welcome: Welcome | null
  events: { type: keyof Events; body: unknown }[]
  rooms: RtcRoom[]
}

describe.skipIf(!existsSync(LIVEKIT))('whisper ↔ server ↔ LiveKit', () => {
  let world: string
  let url: string
  let stop: () => Promise<void>
  let rtc: Rtc
  const people: Person[] = []

  function connect(name: string, link: { serverUrl: string; serverKey: string; code: string }): Promise<Person> {
    const person: Person = { name, connection: null as unknown as Connection, welcome: null, events: [], rooms: [] }
    person.connection = new Connection({
      serverUrl: link.serverUrl, expectedServerKey: link.serverKey, invite: link.code, identity: createIdentity(),
      name: () => name, onStatus: () => undefined, onWelcome: (w) => (person.welcome = w),
      onEvent: (type, body) => person.events.push({ type, body }),
    })
    person.connection.start()
    people.push(person)
    return waitFor(() => person.welcome && person, `${name} online`)
  }

  /** Listens to every audio track in a room; returns the loudest level heard from each sender (dBFS). */
  function listen(room: RtcRoom): Record<string, number> {
    const peaks: Record<string, number> = {}
    room.on('trackSubscribed', (track, _pub, participant) => {
      void (async () => {
        for await (const frame of new rtc.AudioStream(track, 48_000, 1)) {
          let max = 0
          for (const s of frame.data) max = Math.max(max, Math.abs(s))
          if (max > 0) peaks[participant.identity] = Math.max(peaks[participant.identity] ?? -Infinity, 20 * Math.log10(max / 32768))
        }
      })()
    })
    return peaks
  }

  async function room(person: Person, target: { url: string; token: string }, autoSubscribe = true): Promise<RtcRoom> {
    const r = new rtc.Room()
    person.rooms.push(r)
    await r.connect(target.url, target.token, { autoSubscribe, dynacast: false })
    return r
  }

  beforeAll(async () => {
    await ready()
    rtc = (await loadRtc()) as unknown as Rtc
    world = mkdtempSync(join(tmpdir(), 'iskra-whisper-'))
    const port = await freePort()
    const voicePort = await freePort()
    writeFileSync(join(world, 'server.json'), JSON.stringify({
      Name: 'Whisper', Port: port, LocalOnly: true,
      Voice: { Enabled: true, Port: voicePort, RtcTcpPort: await freePort(), RtcUdpPort: await freeUdpPort(), LiveKitPath: LIVEKIT },
    }))
    const proc = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore' })
    url = `http://localhost:${port}`
    stop = () => new Promise((done) => {
      proc.once('exit', () => done())
      proc.kill()
    })
    await waitFor(() => existsSync(join(world, 'owner-invite.txt')), 'server start', 30_000)
    for (const target of [url, `http://127.0.0.1:${voicePort}`]) {
      for (let i = 0; ; i++) {
        try {
          if ((await fetch(target)).ok) break
        } catch {
          if (i > 300) throw new Error(`${target} did not start`)
          await new Promise((r) => setTimeout(r, 100))
        }
      }
    }
    const ownerLink = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))!
    const owner = await connect('Owner', ownerLink)
    await waitFor(() => owner.welcome!.voiceAvailable || owner.events.some((e) => e.type === 'voice.available' && (e.body as Events['voice.available']).available),
      'voice available', 30_000)
  }, 120_000)

  afterAll(async () => {
    for (const p of people) {
      for (const r of p.rooms) await r.disconnect().catch(() => undefined)
      p.connection.stop()
    }
    await stop?.()
    rmSync(world, { recursive: true, force: true })
  })

  it('only the people a whisper reaches can hear it, enforced by LiveKit', async () => {
    const owner = people[0]
    const lounge = (await owner.connection.request('channel.create', { name: 'lounge', kind: 'voice' })).channel
    const invite = async () => {
      const { invite } = await owner.connection.request('invite.create', {})
      return parseInvite(buildInviteLink('http://localhost:5173', { serverUrl: url, serverKey: owner.welcome!.server.key, code: invite.code }))!
    }
    const alice = await connect('Alice', await invite())
    const bob = await connect('Bob', await invite())
    const carol = await connect('Carol', await invite())
    const keyOf = (p: Person) => p.welcome!.you.accountKey

    // Everyone in the channel, for real (LiveKit's webhooks tell the server).
    const mainPeaks: Record<string, Record<string, number>> = {}
    for (const p of [alice, bob, carol]) {
      const r = await room(p, await p.connection.request('voice.join', { channelId: lounge.id }))
      mainPeaks[p.name] = listen(r)
    }
    await waitFor(() => owner.events.some((e) => e.type === 'voice.state' && (e.body as Events['voice.state']).participants.length === 3), 'all three in voice')

    // Alice whispers to Bob. Carol, in the same channel, is told nothing and can't get a token.
    const started = await alice.connection.request('whisper.start', { slot: 1, targets: [keyOf(bob)] })
    expect(started.reached).toEqual([keyOf(bob)])
    const incoming = await waitFor(() => bob.events.find((e) => e.type === 'whisper.incoming'), 'whisper.incoming for Bob')
    expect(incoming.body).toMatchObject({ id: started.id, from: keyOf(alice), channelId: null })
    await expect(carol.connection.request('whisper.join', { id: started.id })).rejects.toMatchObject({ code: 'not_found' })
    expect(carol.events.some((e) => e.type === 'whisper.incoming')).toBe(false)

    // Alice publishes a tone into the whisper room.
    const whisperRoom = await room(alice, started)
    const source = new rtc.AudioSource(48_000, 1)
    const track = rtc.LocalAudioTrack.createAudioTrack('whisper', source)
    await whisperRoom.localParticipant!.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }))
    let playing = true
    void (async () => {
      let n = 0
      while (playing) {
        const frame = Int16Array.from({ length: 480 }, (_, i) => Math.round(16000 * Math.sin((2 * Math.PI * 440 * (n * 480 + i)) / 48_000)))
        n++
        await source.captureFrame(new rtc.AudioFrame(frame, 48_000, 1, 480)).catch(() => undefined)
      }
    })()

    // Bob joins with his listen-only token and hears Alice.
    const bobTarget = await bob.connection.request('whisper.join', { id: started.id })
    const bobWhisper = await room(bob, bobTarget)
    const bobPeaks = listen(bobWhisper)
    await waitFor(() => (bobPeaks[keyOf(alice)] ?? -Infinity) > -20, 'Bob hearing the whisper', 20_000)

    // Nothing of it reaches the voice channel itself: Carol (and Bob there) hear nothing from Alice in the channel room.
    await new Promise((r) => setTimeout(r, 1000))
    expect(mainPeaks.Carol[keyOf(alice)]).toBeUndefined()
    expect(mainPeaks.Bob[keyOf(alice)]).toBeUndefined()

    // Alice changes the list to Carol: the old room is closed, Bob is out of it...
    let bobKicked = false
    bobWhisper.on('disconnected', () => (bobKicked = true))
    const next = await alice.connection.request('whisper.start', { slot: 1, targets: [keyOf(carol)] })
    expect(next.id).not.toBe(started.id)
    expect(next.reached).toEqual([keyOf(carol)])
    await waitFor(() => bobKicked, 'Bob out of the old whisper room')
    playing = false

    // ...and the token he still holds doesn't get him back in: LiveKit lets him join, the webhook check removes him.
    const bobAgain = new rtc.Room()
    bob.rooms.push(bobAgain)
    let removed = false
    bobAgain.on('disconnected', () => (removed = true))
    await bobAgain.connect(bobTarget.url, bobTarget.token, { autoSubscribe: true, dynacast: false }).catch(() => (removed = true))
    await waitFor(() => removed, 'the server removing Bob from a whisper that no longer reaches him', 15_000)
  }, 90_000)
})
