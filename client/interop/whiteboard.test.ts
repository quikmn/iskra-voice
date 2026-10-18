// Whiteboards: two TypeScript clients draw on the same board through the real .NET server, concurrently, and both end
// up with the same board; a late joiner loads it (after the server compacted it). Run with `npm run test:interop`.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BoardState, type Op } from '../src/core/board'
import { Connection } from '../src/core/connection'
import { b64u, ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import { parseInvite } from '../src/core/invite'
import type { Events, Requests, Welcome } from '../src/core/protocol'
import { freePort } from './ports'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')

async function waitFor<T>(check: () => T | undefined | null | false, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** A client the way the app runs one: the board folded from the server's batches, its own changes pending on top. */
interface Drawer {
  name: string
  key: string
  connection: Connection
  welcome: Welcome
  state: BoardState
  lastSeq: number
  live: Events['wb.live'][]
}

describe('whiteboards ↔ server', () => {
  let world: string
  let url: string
  let serverKey: string
  let stop: () => Promise<void>
  const people: Drawer[] = []

  async function connect(code: string, name: string): Promise<Drawer> {
    const identity = createIdentity()
    let welcome: Welcome | null = null
    const person: Drawer = { name, key: b64u(identity.account.publicKey), connection: null!, welcome: null!, state: new BoardState(), lastSeq: 0, live: [] }
    person.connection = new Connection({
      serverUrl: url, expectedServerKey: serverKey, invite: code, identity, name: () => name,
      onStatus: () => undefined, onWelcome: (w) => (welcome = w),
      onEvent: (type, body) => {
        if (type === 'wb.batch') {
          const e = body as Events['wb.batch']
          // Batches arrive in seq order; one already in a wb.get answer is skipped.
          if (e.batch.seq <= person.lastSeq) return
          expect(e.batch.seq).toBe(person.lastSeq + 1)
          person.lastSeq = e.batch.seq
          person.state.applyConfirmed(e.batch.ops!, e.batch.by === person.key ? e.cid : undefined)
        } else if (type === 'wb.live') person.live.push(body as Events['wb.live'])
      },
    })
    person.connection.start()
    await waitFor(() => welcome, `${name} online`)
    person.welcome = welcome!
    people.push(person)
    return person
  }

  async function open(p: Drawer, channelId: number): Promise<Requests['wb.get'][1]> {
    const reply = await p.connection.request('wb.get', { channelId })
    if (reply.snapshot?.objects) p.state.load(reply.snapshot.objects)
    p.lastSeq = reply.snapshot?.seq ?? 0
    for (const b of reply.batches) {
      p.state.applyConfirmed(b.ops!)
      p.lastSeq = b.seq
    }
    return reply
  }

  let cids = 0
  function draw(p: Drawer, channelId: number, boardId: string, ops: Op[]) {
    const cid = `c${++cids}`
    p.state.addPending(cid, ops)
    return p.connection.request('wb.update', { channelId, boardId, cid, ops })
  }

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-wb-'))
    const port = await freePort()
    writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Boards', Port: port, LocalOnly: true, Voice: { Enabled: false } }))
    const proc = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore' })
    url = `http://localhost:${port}`
    stop = () => new Promise((done) => {
      proc.once('exit', () => done())
      proc.kill()
    })
    await waitFor(() => existsSync(join(world, 'owner-invite.txt')), 'server start', 30_000)
    for (;;) {
      try {
        if ((await fetch(url)).ok) break
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    serverKey = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))!.serverKey
  })

  afterAll(async () => {
    people.forEach((p) => p.connection.stop())
    await stop?.()
    rmSync(world, { recursive: true, force: true })
  })

  it('two people draw at once and see the same board; a late joiner loads it', async () => {
    const link = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))!
    const host = await connect(link.code, 'Host')
    const { invite } = await host.connection.request('invite.create', {})
    const friend = await connect(invite.code, 'Friend')
    const { channel } = await host.connection.request('channel.create', { name: 'ideas', kind: 'whiteboard' })
    const boardId = (await open(host, channel.id)).board!.id
    await open(friend, channel.id)

    // Both draw and edit the same shape concurrently, many times over.
    const shape: Op = { id: 'shape-000001', p: { kind: 'rect', x: 0, y: 0, w: 100, h: 60, color: '#1f2328', size: 2, z: 1 } }
    await draw(host, channel.id, boardId, [shape])
    const sends: Promise<unknown>[] = []
    for (let i = 0; i < 15; i++) {
      sends.push(draw(host, channel.id, boardId, [{ id: `host-${String(i).padStart(6, '0')}`, p: { kind: 'pen', x: i, y: 0, pts: [0, 0, 10, 10], color: '#e5484d', size: 3, z: 2 + i } }, { id: 'shape-000001', p: { x: i } }]))
      sends.push(draw(friend, channel.id, boardId, [{ id: `friend-${String(i).padStart(6, '0')}`, p: { kind: 'pen', x: i, y: 9, pts: [0, 0, 5, 5], color: '#0090ff', size: 3, z: 2 + i } }, { id: 'shape-000001', p: { color: i % 2 ? '#30a46c' : '#8e4ec6', y: i } }]))
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 1200)) // stay under the rate limit
    }
    await Promise.all(sends)
    await waitFor(() => host.lastSeq === 31 && friend.lastSeq === 31 && host.state.pendingCount() === 0 && friend.state.pendingCount() === 0, 'every batch everywhere')
    expect(host.state.list()).toEqual(friend.state.list())
    expect(host.state.list()).toHaveLength(31)
    const merged = host.state.get('shape-000001')!
    expect(merged.kind).toBe('rect')
    expect(merged.w).toBe(100)

    // Live cursors go to the other viewer only.
    await friend.connection.request('wb.live', { channelId: channel.id, boardId, live: { x: 5, y: 6, tool: 'pen' } })
    const seen = await waitFor(() => host.live.find((l) => l.accountKey === friend.key), 'a live cursor')
    expect(seen.live).toMatchObject({ x: 5, y: 6 })
    expect(friend.live).toHaveLength(0)

    // Erase some, then a late joiner loads exactly the same board.
    await draw(friend, channel.id, boardId, [{ id: 'host-000003', p: { d: true } }])
    await waitFor(() => host.lastSeq === 32, 'the erase')
    const late = await connect((await host.connection.request('invite.create', {})).invite.code, 'Late')
    await open(late, channel.id)
    expect(late.state.list()).toEqual(host.state.list())
    expect(late.state.list()).toHaveLength(30)
  })
})
