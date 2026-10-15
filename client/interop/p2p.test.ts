// A real Iskra server (localhost only, P2p on) and the real TypeScript client, connected ONLY through the desktop
// app's peer-to-peer tunnel (desktop/src/p2p) over a private HyperDHT testnet on 127.0.0.1: the client is given
// http://127.0.0.1:<friend tunnel port>, never the server's own port. Run with `npm run test:interop`.
/// <reference path="../../desktop/src/p2p/modules.d.ts" />
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type DHT from 'hyperdht'
import type { Testnet } from 'hyperdht/testnet.js'
import { friendKeyPair, hostKeyPair, onlyFriends, parseSecret } from '../../desktop/src/p2p/keys'
import { openTunnel, serveTunnel, type FriendTunnel, type HostTunnel } from '../../desktop/src/p2p/tunnel'
import { Connection, type ConnectionStatus } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import { buildInviteLink, parseInvite, type InviteLink } from '../src/core/invite'
import type { Events, Welcome } from '../src/core/protocol'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const LIVEKIT = resolve(__dirname, '../../.tools', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')
const hasLiveKit = existsSync(LIVEKIT)
const LOCAL = '127.0.0.1'
// The DHT stack lives in the desktop app's dependencies.
const desktopRequire = createRequire(resolve(__dirname, '../../desktop/package.json'))
const HyperDHT = desktopRequire('hyperdht') as typeof DHT
const createTestnet = desktopRequire('hyperdht/testnet.js') as (size: number, opts: { host: string }) => Promise<Testnet>
const { chromium, _electron } = createRequire(resolve(__dirname, '../package.json'))('playwright') as typeof import('playwright')
type Page = import('playwright').Page

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, LOCAL, () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    })
  })

async function waitFor<T>(check: () => T | undefined | null | false, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

class User {
  statuses: ConnectionStatus[] = []
  events: { type: string; body: unknown }[] = []
  welcome: Welcome | null = null
  connection: Connection
  constructor(name: string, invite: InviteLink) {
    this.connection = new Connection({
      serverUrl: invite.serverUrl,
      expectedServerKey: invite.serverKey,
      invite: invite.code,
      identity: createIdentity(),
      name: () => name,
      onStatus: (s) => this.statuses.push(s),
      onWelcome: (w) => (this.welcome = w),
      onEvent: (type, body) => this.events.push({ type, body }),
    })
    this.connection.start()
  }
  online = () => waitFor(() => this.statuses.at(-1)?.state === 'online', 'online')
  event<K extends keyof Events>(type: K, match: (b: Events[K]) => boolean) {
    return waitFor(() => this.events.find((e) => e.type === type && match(e.body as Events[K]))?.body as Events[K], type)
  }
}

describe('Iskra through the peer-to-peer tunnel', () => {
  let world: string
  let proc: ChildProcess
  let directUrl: string
  let tunnelUrl: string
  let testnet: Testnet
  let hostDht: DHT
  let friendDht: DHT
  let strangerDht: DHT
  let host: HostTunnel
  let friend: FriendTunnel
  let secret: Buffer
  let voicePort = 0
  let turnPort = 0
  /** The owner (front door) and the friend (through the tunnel), from the first test on. */
  let owner: User
  let friendUser: User
  const report: Record<string, unknown> = {}

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-p2p-interop-'))
    const port = await freePort()
    voicePort = await freePort()
    const rtcTcp = await freePort()
    const rtcUdp = 40000 + Math.floor(Math.random() * 20000)
    turnPort = rtcUdp + 1
    // Started with P2p on: the server makes p2p.key and writes the tunnel listener's port to p2p.port. With LiveKit
    // (when .tools has it, localhost API), its embedded TURN comes up for the tunnel.
    writeFileSync(join(world, 'server.json'), JSON.stringify({
      Name: 'P2P interop', Port: port, LocalOnly: true, P2p: { Enabled: true }, Retention: { SecurityLogIps: true },
      Voice: { Enabled: hasLiveKit, LiveKitPath: hasLiveKit ? LIVEKIT : null, Port: voicePort, RtcTcpPort: rtcTcp, RtcUdpPort: rtcUdp },
    }))
    proc = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore' })
    directUrl = `http://${LOCAL}:${port}`
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        if ((await fetch(`${directUrl}/`)).ok) break
      } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error('server did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
    const portFile = join(world, 'p2p.port')
    await waitFor(() => existsSync(portFile), 'p2p.port')
    if (hasLiveKit) {
      for (let i = 0; ; i++) {
        try {
          if ((await fetch(`http://${LOCAL}:${voicePort}/`)).ok) break
        } catch { /* starting */ }
        if (i > 300) throw new Error('LiveKit did not start')
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    const tunnelPort = Number(readFileSync(portFile, 'utf8').trim())
    secret = parseSecret(readFileSync(join(world, 'p2p.key'), 'utf8').trim())!
    expect(secret).toBeTruthy()

    testnet = await createTestnet(3, { host: LOCAL })
    const node = () => new HyperDHT({ bootstrap: testnet.bootstrap, host: LOCAL, ephemeral: true })
    hostDht = node()
    friendDht = node()
    strangerDht = node()
    // The host side as the desktop app runs it for a hosted world; the friend side as it runs it for a joined server.
    host = await serveTunnel(hostDht, hostKeyPair(secret), { web: tunnelPort, ...(hasLiveKit ? { turn: turnPort } : {}) }, { allow: onlyFriends(secret) })
    const t0 = performance.now()
    friend = await openTunnel(friendDht, host.publicKey, { web: 0, turn: 0 }, { keyPair: friendKeyPair(secret) })
    report.openTunnelMs = +(performance.now() - t0).toFixed(1)
    tunnelUrl = `http://${LOCAL}:${friend.ports.web}`
  }, 120_000)

  afterAll(async () => {
    owner?.connection.stop()
    friendUser?.connection.stop()
    friend?.close()
    await host?.close()
    await Promise.all([hostDht?.destroy(), friendDht?.destroy(), strangerDht?.destroy()])
    await testnet?.destroy()
    if (proc) {
      await new Promise<void>((done) => {
        proc.once('exit', () => done())
        proc.kill()
      })
    }
    rmSync(world, { recursive: true, force: true })
    console.log(`p2p interop: ${JSON.stringify(report)}`)
  })

  it('members get the secret, invite links carry it, and a friend joins, chats and uploads through the tunnel', async () => {
    const t = performance.now()
    const info = await (await fetch(`${tunnelUrl}/`)).json()
    report.firstHttpMs = +(performance.now() - t).toFixed(1)
    expect(info).toEqual({ iskra: 1, name: 'P2P interop', icon: null }) // the root says only this (no server icon set here)

    // The owner comes in the front door and learns the secret in welcome.
    const ownerLink = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))!
    owner = new User('Host', ownerLink)
    await owner.online()
    expect(owner.welcome?.you.role).toBe('owner')
    expect(owner.welcome?.server.p2p).toBe(secret.toString('base64url'))

    // The invite the owner's app makes: the direct address plus the secret. The friend's app finds the address
    // unreachable and goes through the tunnel; the server key in the link still pins the server.
    const { invite } = await owner.connection.request('invite.create', {})
    const link = buildInviteLink('http://localhost:5173', { serverUrl: directUrl, serverKey: ownerLink.serverKey, code: invite.code, p2p: owner.welcome!.server.p2p! })
    const parsed = parseInvite(link)!
    expect(parsed.p2p).toBe(secret.toString('base64url'))
    expect(hostKeyPair(parseSecret(parsed.p2p)!).publicKey.equals(host.publicKey)).toBe(true)
    const t1 = performance.now()
    friendUser = new User('Friend', { ...parsed, serverUrl: tunnelUrl })
    await friendUser.online()
    report.friendOnlineMs = +(performance.now() - t1).toFixed(1)
    expect(friendUser.welcome?.server.p2p).toBe(secret.toString('base64url'))

    const general = friendUser.welcome!.channels.find((c) => c.name === 'general')!
    const rtts: number[] = []
    for (let i = 0; i < 9; i++) {
      const s = performance.now()
      const { message } = await friendUser.connection.request('chat.send', { channelId: general.id, text: `hello ${i}` })
      await owner.event('chat.message', (b) => b.message.id === message.id)
      rtts.push(performance.now() - s)
    }
    rtts.sort((a, b) => a - b)
    report.chatSendToDeliveryMs = { p50: +rtts[4].toFixed(1), max: +rtts[8].toFixed(1) }
    const back = await owner.connection.request('chat.send', { channelId: general.id, text: 'welcome through the tunnel' })
    await friendUser.event('chat.message', (b) => b.message.id === back.message.id)

    // A 2 MB upload over HTTP PUT through the tunnel, then the download.
    const bytes = new Uint8Array(2 * 1024 * 1024).map((_, i) => i & 0xff)
    const { url } = await friendUser.connection.request('upload.begin', { name: 'blob.bin', size: bytes.length })
    const u = performance.now()
    const put = await fetch(`${tunnelUrl}${url}`, { method: 'PUT', body: bytes })
    expect(put.ok).toBe(true)
    const { file } = await put.json()
    report.upload2MBms = +(performance.now() - u).toFixed(1)
    const d = performance.now()
    const got = new Uint8Array(await (await fetch(`${tunnelUrl}${file.url}`)).arrayBuffer())
    report.download2MBms = +(performance.now() - d).toFixed(1)
    expect(got.length).toBe(bytes.length)
    expect(got[12345]).toBe(bytes[12345])

    // The server counts the friend as a tunnelled session, and logged the address the tunnel named (the friend's
    // DHT socket, here on loopback), not its own.
    const { status } = await owner.connection.request('p2p.status', {})
    expect(status.connected).toBe(1)
    expect(status.enabled).toBe(true)
    const log = await owner.connection.request('security.log.list', {})
    const joined = log.entries.find((e) => e.event === 'member.joined' && e.account === friendUser.welcome!.you.accountKey)!
    expect(joined).toBeTruthy()
    expect(joined.ip).toBe(LOCAL)

    // Rotating the secret reaches members; their invite links use the new one.
    const { status: rotated } = await owner.connection.request('p2p.rotate', {})
    expect(rotated.hostKey).not.toBe(status.hostKey)
    const told = await friendUser.event('server.p2p', (b) => b.p2p !== secret.toString('base64url'))
    expect(told.p2p).toHaveLength(43)
  }, 60_000)

  /**
   * Voice as the desktop app does it (client/src/state/p2pVoice.ts): a page with the real livekit-client (the ESM
   * build the app bundles), reaching LiveKit only through the friend's tunnel ports; the TURN address from the join
   * answer is rewritten to the tunnel, relay only. `open` provides the browser: Playwright's Chromium, or Electron's.
   */
  async function voiceThroughTunnel(label: string, open: (pageUrl: string) => Promise<{ page: Page; close(): Promise<void> }>) {
    // The owner (front door) makes a voice channel; the friend (through the tunnel) asks to join it.
    const { channel } = await owner.connection.request('channel.create', { name: `lounge-${label}`, kind: 'voice' })
    await waitFor(() => friendUser.welcome?.voiceAvailable || friendUser.events.some((e) => e.type === 'voice.available'), 'voice available')
    const joined = await friendUser.connection.request('voice.join', { channelId: channel.id })
    expect(joined.url).toBe(`${tunnelUrl.replace('http', 'ws')}/livekit`)

    const esm = readFileSync(resolve(__dirname, '../node_modules/livekit-client/dist/livekit-client.esm.mjs'))
    const web = http.createServer((req, res) => {
      if (req.url === '/lk.mjs') {
        res.setHeader('content-type', 'text/javascript')
        return res.end(esm)
      }
      res.setHeader('content-type', 'text/html')
      res.end(`<!doctype html><title>lk</title><script>
        const Original = RTCPeerConnection; window.pcs = []; window.configs = []
        window.RTCPeerConnection = class extends Original { constructor(c) { window.configs.push(JSON.parse(JSON.stringify(c ?? {}))); super(c); window.pcs.push(this) } }
      </script><script type="module">import * as LK from '/lk.mjs'; window.LivekitClient = LK</script>`)
    })
    await new Promise<void>((r) => web.listen(0, LOCAL, r))
    const pageLog: string[] = []
    const before = { out: friend.stats.datagramsOut, in: friend.stats.datagramsIn }
    const opened = await open(`http://${LOCAL}:${(web.address() as AddressInfo).port}/`)
    try {
      const { page } = opened
      page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') pageLog.push(`${m.type()}: ${m.text().slice(0, 300)}`) })
      await page.waitForFunction(() => 'LivekitClient' in window)
      type Result = { error?: string; connectMs?: number; pairs?: { type?: string; url?: string; relayProtocol?: string; rttMs: number }[]; bytesSent?: number; offered?: string[][]; configs: RTCConfiguration[] }
      const result = await page.evaluate(async ({ url, token, turnPort }) => {
        type Engine = { makeRTCConfiguration: (r?: unknown) => RTCConfiguration; latestJoinResponse?: { iceServers?: { urls: string[] }[] } }
        type W = Window & { LivekitClient: { Room: new (o: object) => { engine: Engine; connect(u: string, t: string, o: object): Promise<void>; localParticipant: { setMicrophoneEnabled(on: boolean): Promise<unknown> } } }; pcs: RTCPeerConnection[]; configs: RTCConfiguration[] }
        const w = window as unknown as W
        const room = new w.LivekitClient.Room({ adaptiveStream: false, dynacast: false })
        const engine = room.engine
        const original = engine.makeRTCConfiguration.bind(engine)
        engine.makeRTCConfiguration = (response?: unknown) => {
          const config = original(response)
          const turn = (config.iceServers ?? []).filter((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('turn:')))
          return { ...config, iceServers: turn.map((s) => ({ urls: [`turn:127.0.0.1:${turnPort}?transport=udp`], username: s.username, credential: s.credential })), iceTransportPolicy: 'relay' as RTCIceTransportPolicy }
        }
        const t0 = performance.now()
        try {
          await room.connect(url, token, { rtcConfig: { iceTransportPolicy: 'relay' } })
        } catch (e) {
          return { error: String(e), configs: w.configs, offered: engine.latestJoinResponse?.iceServers?.map((s) => s.urls) }
        }
        const connectMs = performance.now() - t0
        await room.localParticipant.setMicrophoneEnabled(true)
        await new Promise((r) => setTimeout(r, 3000))
        const pairs: { type?: string; url?: string; relayProtocol?: string; rttMs: number }[] = []
        let bytesSent = 0
        for (const pc of w.pcs) {
          const report = await pc.getStats()
          const byId = new Map<string, RTCStats>()
          report.forEach((st) => byId.set(st.id, st))
          report.forEach((st) => {
            const pair = st as RTCIceCandidatePairStats
            if (st.type === 'candidate-pair' && pair.nominated && pair.state === 'succeeded') {
              const local = byId.get(pair.localCandidateId) as (RTCStats & { candidateType?: string; url?: string; relayProtocol?: string }) | undefined
              pairs.push({ type: local?.candidateType, url: local?.url, relayProtocol: local?.relayProtocol, rttMs: (pair.currentRoundTripTime ?? 0) * 1000 })
            }
            const out = st as RTCOutboundRtpStreamStats
            if (st.type === 'outbound-rtp' && out.kind === 'audio') bytesSent += out.bytesSent ?? 0
          })
        }
        return { connectMs, pairs, bytesSent, offered: engine.latestJoinResponse?.iceServers?.map((s) => s.urls), configs: w.configs }
      }, { url: joined.url, token: joined.token, turnPort: friend.ports.turn }) as Result
      const datagrams = { out: friend.stats.datagramsOut - before.out, in: friend.stats.datagramsIn - before.in }
      report[`voice-${label}`] = { ...result, configs: undefined, datagrams, pageLog }
      if (result.error) console.log(`voice through the tunnel (${label}) failed: ${result.error}\n${JSON.stringify({ offered: result.offered, configs: result.configs, pageLog, datagrams, host: host.stats })}`)
      expect(result.error).toBeUndefined()
      // LiveKit offered its own TURN on the host's TURN port; the page was told only about the tunnel's address, relay only.
      expect(result.offered!.flat()).toContainEqual(expect.stringMatching(new RegExp(`:${turnPort}\\?transport=udp$`)))
      expect(result.configs.length).toBeGreaterThan(0)
      for (const c of result.configs) {
        expect(c.iceTransportPolicy).toBe('relay')
        for (const ice of c.iceServers ?? []) for (const u of Array.isArray(ice.urls) ? ice.urls : [ice.urls]) expect(u).toBe(`turn:127.0.0.1:${friend.ports.turn}?transport=udp`)
      }
      // The media path in use is the TURN allocation made through the tunnel, audio is being sent, and the datagrams
      // went through the tunnel. The allocation shows as 'prflx' when the SFU answers on another of the host's networks
      // (LiveKit's TURN relays from an any-address socket but names one address): still the same allocation.
      expect(result.pairs!.length).toBeGreaterThan(0)
      for (const pair of result.pairs!) {
        expect(['relay', 'prflx']).toContain(pair.type)
        expect(pair.relayProtocol).toBe('udp')
        expect(pair.url).toBe(`turn:127.0.0.1:${friend.ports.turn}?transport=udp`)
      }
      expect(result.bytesSent).toBeGreaterThan(0)
      expect(datagrams.out).toBeGreaterThan(0)
      expect(datagrams.in).toBeGreaterThan(0)
    } finally {
      await opened.close()
      web.close()
    }
  }

  it.skipIf(!hasLiveKit)('voice goes through the tunnel: LiveKit media relay-only over its TURN, as the desktop app does it', async () => {
    await voiceThroughTunnel('chromium', async (pageUrl) => {
      const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
      const page = await browser.newPage()
      await page.goto(pageUrl)
      return { page, close: () => browser.close() }
    })
  }, 90_000)

  // The same in Electron's own Chromium (the desktop app's engine), with the app's WebRTC policy. Needs a display, so
  // it runs by hand with ISKRA_INTEROP_ELECTRON=1 (WEBRTC_POLICY=default shows the failure the policy fixes).
  it.skipIf(!hasLiveKit || !process.env.ISKRA_INTEROP_ELECTRON)("voice goes through the tunnel in Electron's Chromium too", async () => {
    const electronExe = resolve(__dirname, '../../desktop/node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
    const dir = mkdtempSync(join(tmpdir(), 'iskra-p2p-electron-'))
    writeFileSync(join(dir, 'main.cjs'), `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  // As the desktop app does (desktop/src/main.ts): with the default policy Chromium binds a socket per adapter, and on
  // Windows a LAN-bound socket can't reach the tunnel's TURN on 127.0.0.1.
  w.webContents.setWebRTCIPHandlingPolicy(process.env.WEBRTC_POLICY || 'default_public_interface_only')
  void w.loadURL(process.env.PAGE_URL)
})`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p2p-electron-check', main: 'main.cjs' }))
    try {
      await voiceThroughTunnel('electron', async (pageUrl) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
        const app = await _electron.launch({ executablePath: electronExe, args: [dir, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: { ...env, PAGE_URL: pageUrl } })
        const page = await app.firstWindow()
        return { page, close: () => app.close() }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('refuses a DHT peer that knows the host key but not the secret', async () => {
    const stream = strangerDht.connect(host.publicKey) // its own random key pair
    const outcome = await new Promise<string>((r) => {
      stream.once('open', () => r('open'))
      stream.once('error', (e: Error) => r(`error: ${e.message}`))
      stream.once('close', () => r('closed'))
    })
    report.stranger = outcome
    expect(outcome).not.toBe('open')
    stream.destroy()
  }, 30_000)
})
