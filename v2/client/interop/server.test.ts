// The TypeScript client against the real .NET server, over real WebSockets.
// Run with `npm run test:interop` (builds the server first).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Connection, type ConnectionStatus } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import { buildInviteLink, parseInvite, type InviteLink } from '../src/core/invite'
import type { Events, Welcome } from '../src/core/protocol'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')

interface RunningServer {
  url: string
  world: string
  stop: () => Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer().listen(0, () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    })
  })
}

async function waitFor<T>(check: () => T | undefined | null | false, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

async function startServer(world: string, port: number): Promise<RunningServer> {
  if (!existsSync(join(world, 'server.json')))
    writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Interop', Port: port }))
  const proc: ChildProcess = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore' })
  const url = `http://localhost:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(url)).ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('Server did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    url,
    world,
    stop: () =>
      new Promise((done) => {
        proc.once('exit', () => done())
        proc.kill()
      }),
  }
}

class TestUser {
  readonly identity = createIdentity()
  readonly events: { type: keyof Events; body: unknown }[] = []
  readonly statuses: ConnectionStatus[] = []
  welcome: Welcome | null = null
  readonly connection: Connection

  constructor(name: string, server: { url: string }, invite?: InviteLink) {
    this.connection = new Connection({
      serverUrl: invite?.serverUrl ?? server.url,
      expectedServerKey: invite?.serverKey,
      invite: invite?.code,
      identity: this.identity,
      name: () => name,
      onStatus: (s) => this.statuses.push(s),
      onWelcome: (w) => (this.welcome = w),
      onEvent: (type, body) => this.events.push({ type, body }),
    })
    this.connection.start()
  }

  get status(): ConnectionStatus | undefined {
    return this.statuses.at(-1)
  }

  online = () => waitFor(() => this.status?.state === 'online', 'online')

  event<K extends keyof Events>(type: K, match: (body: Events[K]) => boolean = () => true): Promise<Events[K]> {
    return waitFor(
      () => this.events.find((e) => e.type === type && match(e.body as Events[K]))?.body as Events[K] | undefined,
      `event ${type}`,
    )
  }
}

describe('client ↔ server', () => {
  let world: string
  let port: number
  let server: RunningServer

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-interop-'))
    port = await freePort()
    server = await startServer(world, port)
  })

  afterAll(async () => {
    await server?.stop()
    rmSync(world, { recursive: true, force: true })
  })

  const users: TestUser[] = []
  afterAll(() => users.forEach((u) => u.connection.stop()))

  it('owner claims the server, invites a friend, and they chat', async () => {
    const ownerLink = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))
    expect(ownerLink).not.toBeNull()

    const owner = new TestUser('Host', server, ownerLink!)
    users.push(owner)
    await owner.online()
    expect(owner.welcome?.you.role).toBe('owner')
    expect(owner.welcome?.channels.map((c) => c.name)).toContain('general')

    const { invite } = await owner.connection.request('invite.create', {})
    const link = parseInvite(buildInviteLink('http://localhost:5173', { serverUrl: server.url, serverKey: ownerLink!.serverKey, code: invite.code }))

    const friend = new TestUser('Friend', server, link!)
    users.push(friend)
    await friend.online()
    expect(friend.welcome?.you.role).toBe('member')

    const general = friend.welcome!.channels.find((c) => c.name === 'general')!
    const { message } = await friend.connection.request('chat.send', { channelId: general.id, text: 'hi from TypeScript 👋' })
    const received = await owner.event('chat.message', (b) => b.message.id === message.id)
    expect(received.message.text).toBe('hi from TypeScript 👋')
    expect(received.message.author).toBe(friend.welcome!.you.accountKey)
  })

  it('refuses a server whose key does not match the invite', async () => {
    const impostorLink: InviteLink = { serverUrl: server.url, serverKey: 'B'.repeat(43), code: 'whatever1' }

    const user = new TestUser('Victim', server, impostorLink)
    users.push(user)
    const status = await waitFor(() => (user.status?.state === 'rejected' ? user.status : null), 'rejection')
    expect(status.code).toBe('server_key_mismatch')
  })

  it('reports a missing invite as a rejection and does not retry', async () => {
    const stranger = new TestUser('Stranger', server)
    users.push(stranger)
    const status = await waitFor(() => (stranger.status?.state === 'rejected' ? stranger.status : null), 'rejection')
    expect(status.code).toBe('invite_required')
    await new Promise((r) => setTimeout(r, 1500))
    expect(stranger.statuses.filter((s) => s.state === 'connecting')).toHaveLength(1)
  })

  it('reconnects by itself after a server restart', async () => {
    const owner = users[0]
    await server.stop()
    await waitFor(() => owner.status?.state === 'offline', 'offline')

    server = await startServer(world, port)
    await waitFor(() => owner.status?.state === 'online', 'back online', 40_000)

    const general = owner.welcome!.channels.find((c) => c.name === 'general')!
    const { messages } = await owner.connection.request('chat.history', { channelId: general.id })
    expect(messages.map((m) => m.text)).toContain('hi from TypeScript 👋')
  })
})
