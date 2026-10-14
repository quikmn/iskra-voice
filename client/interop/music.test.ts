// The Music example bot (bots/examples/music-bot.ts): its rules, and on a real server with LiveKit a member sends a song,
// the bot joins their voice channel and plays it, and the controls work. Run with `npm run test:interop`.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bot, encodeWav } from '../../bots/sdk/src/index'
import { loadRtc } from '../../bots/sdk/src/voice/modules'
import { music } from '../../bots/examples/music-bot'
import {
  canControl, isAudio, MAX_PER_PERSON, MusicQueue, parseVolume, readSettings, serverFileLink, titleOf, type QueuedTrack,
} from '../../bots/examples/music-rules'
import { Connection } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import { buildInviteLink, parseInvite } from '../src/core/invite'
import type { Events, Message, Welcome } from '../src/core/protocol'

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

const track = (by: string, title = 'song'): QueuedTrack => ({ title, source: '/files/a/b.mp3', by, byName: by, from: 'upload' })

describe('music rules', () => {
  it('only takes links to files on its own server', () => {
    const server = 'https://chat.example.com'
    expect(serverFileLink('/files/abc_1-2/song.mp3', server)).toBe('/files/abc_1-2/song.mp3')
    expect(serverFileLink('https://chat.example.com/files/abc/song.mp3', server)).toBe('/files/abc/song.mp3')
    expect(serverFileLink('<https://CHAT.example.com/files/abc/song.mp3>', server)).toBe('/files/abc/song.mp3')
    expect(serverFileLink('https://evil.example.com/files/abc/song.mp3', server)).toBeNull()
    expect(serverFileLink('https://chat.example.com:8443/files/abc/song.mp3', server)).toBeNull()
    expect(serverFileLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ', server)).toBeNull()
    expect(serverFileLink('/files/abc/../../etc/passwd', server)).toBeNull()
    expect(serverFileLink('http://127.0.0.1/admin', server)).toBeNull()
    expect(serverFileLink('song', server)).toBeNull()
  })

  it('recognizes audio and names songs', () => {
    expect(isAudio({ name: 'a.bin', type: 'audio/mpeg' })).toBe(true)
    expect(isAudio({ name: 'track.FLAC', type: 'application/octet-stream' })).toBe(true)
    expect(isAudio({ name: 'cat.png', type: 'image/png' })).toBe(false)
    expect(titleOf('SPOILER_My_Song.mp3')).toBe('My Song')
    expect(titleOf('Caf%C3%A9.ogg')).toBe('Café')
    expect(parseVolume('80')).toBe(0.8)
    expect(parseVolume('150%')).toBe(1.5)
    expect(parseVolume(250)).toBeNull()
    expect(parseVolume('loud')).toBeNull()
  })

  it('lets the chosen people control it, everyone their own songs, admins always', () => {
    const everyone = readSettings({})
    const trusted = readSettings({ control: { kind: 'level', level: 'trusted' } })
    const dj = readSettings({ control: { kind: 'role', id: 7, name: 'DJ' }, volume: 9 })
    expect(dj.volume).toBe(1)
    expect(readSettings({ control: { kind: 'level', level: 'owner' } }).control).toEqual({ kind: 'everyone' })
    const member = { role: 'member' as const, roles: [] }
    expect(canControl(everyone, member)).toBe(true)
    expect(canControl(trusted, member)).toBe(false)
    expect(canControl(trusted, { role: 'trusted' })).toBe(true)
    expect(canControl(dj, member)).toBe(false)
    expect(canControl(dj, { role: 'member', roles: [7] })).toBe(true)
    expect(canControl(dj, { role: 'admin' })).toBe(true)
    expect(canControl(dj, member, true)).toBe(true)
    expect(canControl(everyone, undefined)).toBe(false)
  })

  it('keeps a queue with limits', () => {
    const queue = new MusicQueue()
    expect(queue.add(track('a', 'one'), track('b', 'two'), track('a', 'three'))).toBe(3)
    expect(queue.next()?.title).toBe('one')
    expect(queue.upcoming.map((t) => t.title)).toEqual(['two', 'three'])
    expect(queue.remove(2)?.title).toBe('three')
    expect(queue.remove(5)).toBeNull()
    expect(queue.listing()).toContain('▶ **one** (a)')
    expect(queue.add(...Array.from({ length: 30 }, () => track('c')))).toBe(MAX_PER_PERSON)
    expect(queue.clear()).toBe(MAX_PER_PERSON + 1)
    expect(queue.next()).toBeUndefined()
  })
})

describe('Music bot ↔ server and LiveKit', () => {
  let world: string
  let url: string
  let stop: () => Promise<void>
  let owner: Connection
  let welcome: Welcome | null = null
  const events: { type: keyof Events; body: unknown }[] = []
  const bots: Bot[] = []

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-music-'))
    const port = await freePort()
    const voicePort = await freePort()
    writeFileSync(join(world, 'server.json'), JSON.stringify({
      Name: 'Music', Port: port, LocalOnly: true,
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

  const message = (match: (m: Message) => boolean) =>
    waitFor(() => events.map((e) => (e.type === 'chat.message' || e.type === 'chat.edited' ? (e.body as Events['chat.message']).message : null))
      .find((m) => m && match(m)), 'a message')

  it('plays a song a member attached, with a queue and controls', async () => {
    const general = welcome!.channels.find((c) => c.name === 'general')!
    const lounge = (await owner.request('channel.create', { name: 'lounge', kind: 'voice' })).channel
    const { invite } = await owner.request('bot.invite', { voice: true })
    const bot = new Bot({ name: 'Music', invite: buildInviteLink('http://localhost:5173', { serverUrl: url, serverKey: welcome!.server.key, code: invite.code }),
      stateFile: join(world, 'music.bot.json'), log: () => undefined })
    const settingsFile = join(world, 'music.settings.json')
    music(bot, { settingsFile })
    bots.push(bot)
    await bot.start()
    const key = bot.me!.accountKey

    // The member is in the lounge, listening with LiveKit's SDK like an app.
    const rtc = await loadRtc() as unknown as {
      Room: new () => { on(e: 'trackSubscribed', l: (track: unknown, p: unknown, who: { identity: string }) => void): unknown; connect(u: string, t: string, o: object): Promise<void>; disconnect(): Promise<void> }
      AudioStream: new (track: unknown, rate: number, channels: number) => AsyncIterable<{ data: Int16Array }>
    }
    const { url: voiceUrl, token } = await owner.request('voice.join', { channelId: lounge.id })
    const room = new rtc.Room()
    let peak = -Infinity
    room.on('trackSubscribed', (t, _p, who) => {
      if (who.identity !== key) return
      void (async () => {
        for await (const frame of new rtc.AudioStream(t, 48_000, 1)) {
          let max = 0
          for (const s of frame.data) max = Math.max(max, Math.abs(s))
          if (max > 0) peak = Math.max(peak, 20 * Math.log10(max / 32768))
        }
      })()
    })
    await room.connect(voiceUrl, token, { autoSubscribe: true, dynacast: false })
    await waitFor(() => bot.voiceChannelOf(welcome!.you.accountKey) === lounge.id, 'the bot seeing the member in voice')

    // A song uploaded to the server, attached to a message that mentions the bot.
    const tone = Float32Array.from({ length: 48_000 * 6 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000))
    const wav = encodeWav([tone], 48_000)
    const ticket = await owner.request('upload.begin', { name: 'Test_Tone.wav', size: wav.length })
    const { file } = (await (await fetch(url + ticket.url, { method: 'PUT', body: new Blob([wav as Uint8Array<ArrayBuffer>]) })).json()) as { file: { id: string; url: string } }
    await owner.request('chat.send', { channelId: general.id, text: `<@${key}> play this`, attachments: [file.id] })

    await message((m) => m.author === key && m.text.includes('started the music with **Test Tone**'))
    const card = await message((m) => m.author === key && !!m.cards?.[0]?.title?.includes('Now playing'))
    expect(card.cards![0].description).toBe('**Test Tone**')
    await waitFor(() => peak > -20, 'the member hearing the song', 20_000)

    // Commands from the app: a second song by link, an outside address refused, pause, volume, the queue.
    // interaction.invoke allows 2 a second.
    const invoke = async (command: string, options: Record<string, string | number> = {}) => {
      await new Promise((r) => setTimeout(r, 550))
      return owner.request('interaction.invoke', { bot: key, channelId: general.id, command, options })
    }
    await invoke('play', { song: `${url}${file.url}` })
    await message((m) => m.author === key && m.text.includes('added **Test Tone** (1 in the queue)'))
    const outside = await invoke('play', { song: 'https://www.youtube.com/watch?v=x' })
    const refusal = await waitFor(() => events.find((e) => e.type === 'interaction.response' && (e.body as Events['interaction.response']).interaction === outside.id)
      ?.body as Events['interaction.response'] | undefined, 'the refusal')
    expect(refusal.text).toMatch(/only play files uploaded to this server/)

    await invoke('pause')
    await message((m) => m.author === key && m.text.includes('paused the music'))
    expect(bot.voice?.state).toBe('paused')
    await invoke('volume', { percent: 50 })
    await message((m) => m.author === key && m.text.includes('set the volume to 50 %'))
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).volume).toBe(0.5)

    // Admins choose who controls it; the card's Stop button ends it and the bot leaves voice.
    await invoke('music-control', { who: 'admin' })
    await message((m) => m.author === key && m.text.includes('admins can control the music'))
    await new Promise((r) => setTimeout(r, 550))
    await owner.request('interaction.invoke', { messageId: card.id, customId: 'music:stop' })
    await message((m) => m.id === card.id && !!m.cards?.[0]?.title?.includes('Stopped'))
    await waitFor(() => bot.voice === null, 'the bot leaving voice')
    await room.disconnect()
  }, 90_000)
})
