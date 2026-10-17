import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { ready } from '../core/crypto'
import { createIdentity } from '../core/identity'
import type { InviteLink } from '../core/invite'
import type { Welcome } from '../core/protocol'
import type { SavedServer } from '../core/storage'

// This device's saved server list, in memory. The write that carries the invite (the join's follow-up) can be made
// slow: a save that lands late must not undo a newer one.
const disk = vi.hoisted(() => ({ servers: [] as { invite?: string }[], slowInviteSave: 0 }))
vi.mock('../core/storage', async (original) => ({
  ...(await original<typeof import('../core/storage')>()),
  loadServers: async () => structuredClone(disk.servers),
  saveServers: async (servers: { invite?: string }[]) => {
    if (disk.slowInviteSave && servers.some((s) => s.invite)) await new Promise((r) => setTimeout(r, disk.slowInviteSave))
    disk.servers = structuredClone(servers)
  },
}))

// No sockets: the fake connection hands its callbacks to the test, so the welcome arrives when the test says.
const sockets = vi.hoisted(() => ({ opened: [] as { expectedServerKey: string; onWelcome: (welcome: Welcome) => void }[] }))
vi.mock('../core/connection', () => ({
  Connection: class {
    constructor(opts: { expectedServerKey: string; onWelcome: (welcome: Welcome) => void }) { sockets.opened.push(opts) }
    start() {}
    stop() {}
    retryNow() {}
    request() { return new Promise(() => undefined) }
  },
}))

import { acceptInvite, useApp } from './store'

const invite = { serverUrl: 'http://localhost:4000', serverKey: 'srv', code: 'abcdef' } as InviteLink
const welcome = {
  server: { name: 'Test server' },
  you: { accountKey: 'pat', name: 'Pat', role: 'member', roles: [] },
  channels: [], members: [], voice: [], voiceAvailable: false,
} as unknown as Welcome

const savedInvite = () => (disk.servers as SavedServer[]).find((s) => s.serverKey === invite.serverKey)?.invite

beforeAll(async () => {
  await ready()
})

beforeEach(() => {
  disk.servers = []
  disk.slowInviteSave = 0
  sockets.opened.length = 0
  useApp.setState({ identity: createIdentity(), servers: {}, order: [] })
})

it('the invite remembered at join time is dropped once the welcome made us a member, even when its write is slow', async () => {
  disk.slowInviteSave = 20
  acceptInvite(invite)
  sockets.opened.at(-1)!.onWelcome(welcome) // the welcome comes before the invite is written down
  await new Promise((r) => setTimeout(r, 120))
  // A saved invite would make the next start connect as a join again (and a join's welcome opens the role picker).
  expect(savedInvite()).toBeUndefined()
  expect(useApp.getState().servers[invite.serverKey]?.joining).toBe(false)
})

it('the invite is kept while the join is still on its way, in case the tab closes', async () => {
  acceptInvite(invite)
  await new Promise((r) => setTimeout(r, 20))
  expect(savedInvite()).toBe('abcdef')
})
