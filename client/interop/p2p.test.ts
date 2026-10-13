// A real Iskra server (localhost only, P2p on) and the real TypeScript client, connected ONLY through the desktop
// app's peer-to-peer tunnel (desktop/src/p2p) over a private HyperDHT testnet on 127.0.0.1: the client is given
// http://127.0.0.1:<friend tunnel port>, never the server's own port. Run with `npm run test:interop`.
/// <reference path="../../desktop/src/p2p/modules.d.ts" />
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
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
const LOCAL = '127.0.0.1'
// The DHT stack lives in the desktop app's dependencies.
const desktopRequire = createRequire(resolve(__dirname, '../../desktop/package.json'))
const HyperDHT = desktopRequire('hyperdht') as typeof DHT
const createTestnet = desktopRequire('hyperdht/testnet.js') as (size: number, opts: { host: string }) => Promise<Testnet>

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
  const report: Record<string, unknown> = {}

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-p2p-interop-'))
    const port = await freePort()
    // Started with P2p on: the server makes p2p.key and writes the tunnel listener's port to p2p.port.
    writeFileSync(join(world, 'server.json'), JSON.stringify({
      Name: 'P2P interop', Port: port, LocalOnly: true, P2p: { Enabled: true }, Voice: { Enabled: false }, Retention: { SecurityLogIps: true },
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
    const tunnelPort = Number(readFileSync(portFile, 'utf8').trim())
    secret = parseSecret(readFileSync(join(world, 'p2p.key'), 'utf8').trim())!
    expect(secret).toBeTruthy()

    testnet = await createTestnet(3, { host: LOCAL })
    const node = () => new HyperDHT({ bootstrap: testnet.bootstrap, host: LOCAL, ephemeral: true })
    hostDht = node()
    friendDht = node()
    strangerDht = node()
    // The host side as the desktop app runs it for a hosted world; the friend side as it runs it for a joined server.
    host = await serveTunnel(hostDht, hostKeyPair(secret), { web: tunnelPort }, { allow: onlyFriends(secret) })
    const t0 = performance.now()
    friend = await openTunnel(friendDht, host.publicKey, { web: 0 }, { keyPair: friendKeyPair(secret) })
    report.openTunnelMs = +(performance.now() - t0).toFixed(1)
    tunnelUrl = `http://${LOCAL}:${friend.ports.web}`
  }, 120_000)

  afterAll(async () => {
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
    expect(info).toEqual({ iskra: 1, name: 'P2P interop' })

    // The owner comes in the front door and learns the secret in welcome.
    const ownerLink = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))!
    const owner = new User('Host', ownerLink)
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
    const friendUser = new User('Friend', { ...parsed, serverUrl: tunnelUrl })
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

    owner.connection.stop()
    friendUser.connection.stop()
  }, 60_000)

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
