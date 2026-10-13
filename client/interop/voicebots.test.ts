// Voice bots: the SDK's audio pipeline, and a bot that joins a voice channel on a real server with LiveKit and plays
// audio that a member receives. Run with `npm run test:interop` (LiveKit from .tools: scripts/get-livekit.*).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bot, encodeWav, type TrackEnd, type VoiceGone } from '../../bots/sdk/src/index'
import { applyVolume, Framer, FRAME, sniff, toStereo, WavDecoder } from '../../bots/sdk/src/voice/audio'
import { loadRtc } from '../../bots/sdk/src/voice/modules'
import { Connection } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import { buildInviteLink, parseInvite } from '../src/core/invite'
import type { Events, Welcome } from '../src/core/protocol'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const LIVEKIT = resolve(__dirname, '../../.tools', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')

const freePort = () => new Promise<number>((done) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const port = (probe.address() as { port: number }).port
    probe.close(() => done(port))
  })
})

async function waitFor<T>(check: () => T | undefined | null | false, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** A sine tone, planar. */
const tone = (seconds: number, hz: number, rate: number, channels = 1, level = 0.5) =>
  Array.from({ length: channels }, () => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / rate)))

describe('voice bot audio', () => {
  it('recognizes formats from their first bytes', () => {
    const bytes = (...parts: (string | number[])[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))
    expect(sniff(encodeWav(tone(0.01, 440, 8000), 8000))).toBe('wav')
    expect(sniff(bytes('fLaC', [0, 0, 0, 34]))).toBe('flac')
    expect(sniff(bytes('OggS', new Array(24).fill(0), 'OpusHead'))).toBe('opus')
    expect(sniff(bytes('OggS', new Array(24).fill(0), '\x01vorbis'))).toBe('vorbis')
    expect(sniff(bytes('ID3', [4, 0, 0]))).toBe('mp3')
    expect(sniff(bytes([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3')
    expect(sniff(bytes([0xff, 0xf1, 0x50, 0x80]))).toEqual({ unsupported: 'AAC' })
    expect(sniff(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toEqual({ unsupported: 'MP4/M4A (AAC)' })
    expect(sniff(bytes('<!doctype html>'))).toMatchObject({ unsupported: expect.stringMatching(/web page/) })
  })

  it('decodes WAV in any chunks, at any bit depth', async () => {
    const left = tone(0.1, 440, 44_100)[0]
    const right = tone(0.1, 660, 44_100)[0]
    const wav = encodeWav([left, right], 44_100)
    const decoder = new WavDecoder()
    const decoded = []
    for (let at = 0; at < wav.length; at += 7) decoded.push(...(await decoder.push(wav.slice(at, at + 7)))) // a header split anywhere
    await decoder.end()
    const samples = decoded.reduce((n, d) => n + d.samplesDecoded, 0)
    expect(samples).toBe(left.length)
    expect(decoded[0]).toMatchObject({ sampleRate: 44_100 })
    expect(decoded[0].channelData).toHaveLength(2)
    const joined = (c: number) => Float32Array.from(decoded.flatMap((d) => Array.from(d.channelData[c])))
    expect(Math.max(...joined(0).map((v, i) => Math.abs(v - left[i])))).toBeLessThan(1e-4)
    expect(Math.max(...joined(1).map((v, i) => Math.abs(v - right[i])))).toBeLessThan(1e-4)

    // 24-bit, the header's "data" size left at 0 (as streams do).
    const pcm24 = Uint8Array.from([...wav.subarray(0, 44)])
    const view = new DataView(pcm24.buffer)
    view.setUint16(22, 1, true)
    view.setUint32(28, 44_100 * 3, true)
    view.setUint16(32, 3, true)
    view.setUint16(34, 24, true)
    view.setUint32(40, 0, true)
    const body = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]) // +0.5, -0.5
    const d24 = new WavDecoder()
    const [out] = await d24.push(Uint8Array.from([...pcm24, ...body]))
    expect(Array.from(out.channelData[0])).toEqual([0.5, -0.5])

    await expect(new WavDecoder().end()).rejects.toThrow(/no audio/)
    const adpcm = Uint8Array.from(wav.subarray(0, 44))
    new DataView(adpcm.buffer).setUint16(20, 2, true)
    await expect(new WavDecoder().push(adpcm)).rejects.toThrow(/Only PCM/)
  })

  it('mixes to stereo, sets the volume and cuts 10 ms frames', () => {
    const mono = toStereo({ channelData: [Float32Array.of(0.5, -1)], samplesDecoded: 2, sampleRate: 48_000 })
    expect(Array.from(mono)).toEqual([16384, 16384, -32767, -32767])
    const surround = toStereo({ channelData: [Float32Array.of(1), Float32Array.of(1), Float32Array.of(1), Float32Array.of(1)], samplesDecoded: 1, sampleRate: 48_000 })
    expect(surround[0]).toBeLessThanOrEqual(32767)
    const loud = Int16Array.of(20_000, -20_000, 100)
    applyVolume(loud, 2)
    expect(Array.from(loud)).toEqual([32767, -32768, 200])
    applyVolume(loud, 0)
    expect(Array.from(loud)).toEqual([0, 0, 0])

    const framer = new Framer()
    expect(framer.push(new Int16Array(FRAME * 2 - 2))).toHaveLength(0)
    const frames = framer.push(new Int16Array(FRAME * 2 * 2 + 4).fill(7))
    expect(frames).toHaveLength(3)
    expect(frames.every((f) => f.length === FRAME * 2)).toBe(true)
    const last = framer.flush()
    expect(last).toHaveLength(1)
    expect(last[0].slice(0, 2)).toEqual(Int16Array.of(7, 7))
    expect(last[0][2]).toBe(0)
  })
})

describe.skipIf(!existsSync(LIVEKIT))('voice bot ↔ server ↔ LiveKit', () => {
  let world: string
  let url: string
  let stop: () => Promise<void>
  let owner: Connection
  let welcome: Welcome | null = null
  const events: { type: keyof Events; body: unknown }[] = []
  const bots: Bot[] = []

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-voicebots-'))
    const port = await freePort()
    const voicePort = await freePort()
    writeFileSync(join(world, 'server.json'), JSON.stringify({
      Name: 'Voice bots', Port: port, LocalOnly: true,
      Voice: { Enabled: true, Port: voicePort, RtcTcpPort: await freePort(), RtcUdpPort: 40000 + Math.floor(Math.random() * 20000), LiveKitPath: LIVEKIT },
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
    const link = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))!
    owner = new Connection({
      serverUrl: link.serverUrl, expectedServerKey: link.serverKey, invite: link.code, identity: createIdentity(),
      name: () => 'Host', onStatus: () => undefined, onWelcome: (w) => (welcome = w),
      onEvent: (type, body) => events.push({ type, body }),
    })
    owner.start()
    await waitFor(() => welcome, 'owner online')
    await waitFor(() => welcome!.voiceAvailable || events.some((e) => e.type === 'voice.available' && (e.body as Events['voice.available']).available),
      'voice available', 30_000)
  }, 120_000)

  afterAll(async () => {
    for (const b of bots) {
      await b.voice?.leave()
      b.stop()
    }
    owner?.stop()
    await stop?.()
    rmSync(world, { recursive: true, force: true })
  })

  it('a bot an admin allowed joins voice and plays audio that a member hears', async () => {
    const lounge = (await owner.request('channel.create', { name: 'lounge', kind: 'voice' })).channel
    const { invite } = await owner.request('bot.invite', { voice: true })
    const bot = new Bot({ name: 'Jukebox', invite: buildInviteLink('http://localhost:5173', { serverUrl: url, serverKey: welcome!.server.key, code: invite.code }),
      stateFile: join(world, 'jukebox.bot.json'), log: () => undefined })
    bots.push(bot)
    await bot.start()
    expect(bot.me?.joinsVoice).toBe(true)

    // The member listens with LiveKit's own SDK, like an app would.
    const rtc = await loadRtc() as unknown as ListenerRtc
    const { url: voiceUrl, token } = await owner.request('voice.join', { channelId: lounge.id })
    const room = new rtc.Room()
    let peak = -Infinity
    let from = ''
    room.on('trackSubscribed', (track: unknown, _publication: unknown, participant: { identity: string }) => {
      from = participant.identity
      void (async () => {
        for await (const frame of new rtc.AudioStream(track, 48_000, 1) as AsyncIterable<{ data: Int16Array }>) {
          let max = 0
          for (const s of frame.data) max = Math.max(max, Math.abs(s))
          if (max > 0) peak = Math.max(peak, 20 * Math.log10(max / 32768))
        }
      })()
    })
    await room.connect(voiceUrl, token, { autoSubscribe: true, dynacast: false })

    const voice = await bot.joinVoice(lounge.id)
    await waitFor(() => events.some((e) => e.type === 'voice.state'
      && (e.body as Events['voice.state']).participants.some((p) => p.accountKey === bot.me!.accountKey)), 'the bot in voice.state')

    // 44.1 kHz mono: decoded, resampled to 48 kHz stereo and published.
    const ends: TrackEnd[] = []
    voice.on('trackEnd', (end) => ends.push(end))
    const played = voice.play(encodeWav(tone(4, 440, 44_100), 44_100), { title: 'A440' })
    expect(voice.state).toBe('playing')
    expect(voice.nowPlaying?.title).toBe('A440')
    await waitFor(() => peak > -20 && from === bot.me!.accountKey, 'the member hearing the bot', 20_000)
    expect((await played).reason).toBe('finished')
    expect(ends.map((e) => e.reason)).toEqual(['finished'])

    // Formats it can't play end the track with a clear error.
    const bad = await voice.play(new TextEncoder().encode('<!doctype html><html></html>'.padEnd(80)))
    expect(bad.reason).toBe('error')
    expect(bad.error?.message).toMatch(/web page/)

    // Replacing and stopping.
    const first = voice.play(encodeWav(tone(10, 220, 48_000, 2), 48_000))
    const second = voice.play(encodeWav(tone(10, 330, 48_000, 2), 48_000))
    expect((await first).reason).toBe('replaced')
    voice.pause()
    expect(voice.state).toBe('paused')
    voice.resume()
    voice.setVolume(0.5)
    voice.stop()
    expect((await second).reason).toBe('stopped')
    expect(voice.state).toBe('idle')

    // A moderator disconnects it: the bot hears it was kicked.
    const gone: VoiceGone[] = []
    voice.on('kicked', (g) => gone.push(g))
    await owner.request('voice.disconnect', { accountKey: bot.me!.accountKey })
    await waitFor(() => gone.length > 0, 'kicked')
    expect(gone[0]).toEqual({ channelId: lounge.id, reason: 'kicked' })
    expect(voice.state).toBe('left')
    expect(bot.voice).toBeNull()
    await room.disconnect()
  }, 60_000)
})

/** The parts of LiveKit's SDK the listening member uses (beyond what the bot SDK declares). */
interface ListenerRtc {
  Room: new () => {
    on(event: 'trackSubscribed', listener: (track: unknown, publication: unknown, participant: { identity: string }) => void): unknown
    connect(url: string, token: string, opts: { autoSubscribe: boolean; dynacast: boolean }): Promise<void>
    disconnect(): Promise<void>
  }
  AudioStream: new (track: unknown, sampleRate: number, channels: number) => unknown
}
