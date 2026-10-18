// A standalone server (no desktop app) reached through its own peer-to-peer tunnel: the real iskra-server starts the
// iskra-p2p sidecar (desktop/src/p2p/sidecarMain.ts, bundled as the release build bundles it, run with node instead
// of as a single executable) on a private HyperDHT testnet on 127.0.0.1, and the real TypeScript client joins and
// chats ONLY through the friend side of the tunnel. Then a new secret, and the server stopping takes the tunnel with
// it. Run with `npm run test:interop`.
/// <reference path="../../desktop/src/p2p/modules.d.ts" />
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type DHT from 'hyperdht'
import type { Testnet } from 'hyperdht/testnet.js'
import { friendKeyPair, hostKeyPair, parseSecret } from '../../desktop/src/p2p/keys'
import { openTunnel, type FriendTunnel } from '../../desktop/src/p2p/tunnel'
import { Connection, type ConnectionStatus } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import { parseInvite, type InviteLink } from '../src/core/invite'
import type { Events, P2pStatus, Welcome } from '../src/core/protocol'
import { freePort } from './ports'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const LOCAL = '127.0.0.1'
const desktopRequire = createRequire(resolve(__dirname, '../../desktop/package.json'))
const HyperDHT = desktopRequire('hyperdht') as typeof DHT
const createTestnet = desktopRequire('hyperdht/testnet.js') as (size: number, opts: { host: string }) => Promise<Testnet>

async function waitFor<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
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

describe('a standalone server through its iskra-p2p sidecar', () => {
  let world: string
  let proc: ChildProcess
  let serverLog = ''
  let directUrl: string
  let testnet: Testnet
  let friendDht: DHT
  const tunnels: FriendTunnel[] = []
  let owner: User
  let friend: User

  /** The friend side of the tunnel for a secret, and whether the server answers through it. */
  async function tunnelFor(secret: string) {
    const key = parseSecret(secret)!
    const tunnel = await openTunnel(friendDht, hostKeyPair(key).publicKey, { web: 0 }, { keyPair: friendKeyPair(key) })
    tunnels.push(tunnel)
    return `http://${LOCAL}:${tunnel.ports.web}`
  }
  const answers = async (url: string, ms = 4000) => {
    try {
      const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(ms) })
      return ((await response.json()) as { iskra?: number }).iskra === 1
    } catch {
      return false
    }
  }
  const status = async () => (await owner.connection.request('p2p.status', {})).status as P2pStatus

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-p2p-sidecar-interop-'))
    testnet = await createTestnet(3, { host: LOCAL })
    friendDht = new HyperDHT({ bootstrap: testnet.bootstrap, host: LOCAL, ephemeral: true })

    // The sidecar as the release build bundles it (desktop/scripts/build-sidecar.mjs), addons from node_modules. Or a
    // built single executable: ISKRA_P2P_SIDECAR_EXE=desktop/build/p2p-<os>-<arch>/iskra-p2p[.exe] (bound to 127.0.0.1).
    const sidecar = process.env.ISKRA_P2P_SIDECAR_EXE ? resolve(process.env.ISKRA_P2P_SIDECAR_EXE) : `${world}-sidecar.cjs`
    if (!process.env.ISKRA_P2P_SIDECAR_EXE) {
      const build = (await import(pathToFileURL(resolve(__dirname, '../../desktop/scripts/build-sidecar.mjs')).href)) as { bundleSidecar(out: string): Promise<unknown> }
      await build.bundleSidecar(sidecar)
    }

    const port = await freePort()
    writeFileSync(join(world, 'server.json'), JSON.stringify({
      Name: 'Standalone P2P', Port: port, LocalOnly: true, Voice: { Enabled: false },
      P2p: { Enabled: true, SidecarPath: sidecar, Bootstrap: testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',') },
    }))
    const env = { ...process.env, ISKRA_STOP_ON_STDIN_CLOSE: '1' }
    delete env.ISKRA_P2P_TUNNEL // a standalone server: it runs the tunnel itself
    proc = spawn('dotnet', [SERVER_DLL, world], { stdio: ['pipe', 'pipe', 'pipe'], env })
    proc.stdout?.on('data', (d) => (serverLog += d))
    proc.stderr?.on('data', (d) => (serverLog += d))
    directUrl = `http://${LOCAL}:${port}`
    await waitFor(() => answers(directUrl, 1000), 'the server')
  }, 120_000)

  afterAll(async () => {
    owner?.connection.stop()
    friend?.connection.stop()
    for (const t of tunnels) t.close()
    if (proc && proc.exitCode === null) {
      await new Promise<void>((done) => {
        proc.once('exit', () => done())
        proc.kill()
      })
    }
    await friendDht?.destroy()
    await testnet?.destroy()
    rmSync(world, { recursive: true, force: true })
    rmSync(`${world}-sidecar.cjs`, { force: true })
  })

  it('announces the server, lets a friend in through the tunnel, follows a new secret and stops with the server', async () => {
    const ownerLink = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))!
    owner = new User('Host', ownerLink)
    await owner.online()
    const secret = owner.welcome!.server.p2p!
    expect(secret).toHaveLength(43)

    // The server's own tunnel comes up and says so to the owner.
    const up = await waitFor(async () => {
      const s = await status()
      return s.tunnel?.state === 'ready' && s
    }, `the sidecar to be ready (server log:\n${serverLog})`)
    expect(up.tunnel!.nat).not.toBeNull()

    // A friend reaches the server only through the tunnel and joins with an invite.
    const tunnelUrl = await tunnelFor(secret)
    expect(await waitFor(() => answers(tunnelUrl), 'an answer through the tunnel')).toBe(true)
    const { invite } = await owner.connection.request('invite.create', {})
    friend = new User('Friend', { serverUrl: tunnelUrl, serverKey: ownerLink.serverKey, code: invite.code })
    await friend.online()
    const general = friend.welcome!.channels.find((c) => c.name === 'general')!
    const { message } = await friend.connection.request('chat.send', { channelId: general.id, text: 'hello from behind a CGNAT' })
    await owner.event('chat.message', (b) => b.message.id === message.id)
    const busy = await waitFor(async () => {
      const s = await status()
      return s.connected === 1 && (s.tunnel?.connections ?? 0) >= 1 && s
    }, 'the tunnelled session in p2p.status', 20_000)
    expect(busy.tunnel!.state).toBe('ready')

    // A new secret: the sidecar announces the new key; links with the new secret work.
    await owner.connection.request('p2p.rotate', {})
    const next = (await friend.event('server.p2p', (b) => !!b.p2p && b.p2p !== secret)).p2p!
    const nextUrl = await tunnelFor(next)
    expect(await waitFor(() => answers(nextUrl), 'an answer with the new secret')).toBe(true)

    // Stopping the server (as the desktop app or a service manager does) stops its tunnel too.
    const exited = new Promise<number | null>((done) => proc.once('exit', (code) => done(code)))
    proc.stdin?.end()
    expect(await exited).toBe(0)
    // Nobody accepts the friend key any more: the sidecar left the DHT (not merely a dead server behind it).
    const key = parseSecret(next)!
    const stream = friendDht.connect(hostKeyPair(key).publicKey, { keyPair: friendKeyPair(key) })
    const outcome = await new Promise<string>((done) => {
      setTimeout(() => done('no answer'), 20_000)
      stream.once('open', () => done('open'))
      stream.once('error', (e: Error) => done(`error: ${e.message}`))
      stream.once('close', () => done('closed'))
    })
    stream.destroy()
    expect(outcome).not.toBe('open')
  }, 120_000)
})
