import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredDm } from '../core/storage'
import { mergeDm } from './dmMerge'

const NOW = 1_760_000_000_000
const saved: Record<string, StoredDm[]> = {}
const stored: Record<string, StoredDm[]> = {
  peer: [
    { id: 'a', from: 'peer', to: 'me', text: 'gone while the app was closed', sentAt: NOW - 600_000, expiresAt: NOW - 300_000 },
    { id: 'b', from: 'peer', to: 'me', text: 'still here', sentAt: NOW - 60_000, expiresAt: NOW + 60_000 },
    { id: 'c', from: 'me', to: 'peer', text: 'kept for good', sentAt: NOW - 30_000 },
  ],
}

vi.mock('../core/storage', () => ({
  loadDmHistory: async () => stored,
  saveDmConversation: async (peer: string, messages: StoredDm[]) => {
    saved[peer] = messages
  },
  deleteDmConversation: async () => undefined,
  loadGroups: async () => [],
  saveGroup: async () => undefined,
}))
vi.mock('./keyMap', () => ({ keysReady: async () => undefined, resolveKey: (k: string) => k, sameAccount: (a: string, b: string) => a === b }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('disappearing messages on this device', () => {
  it("drops what expired while the app was closed, and deletes the rest on time, from storage too", async () => {
    const dms = await import('./dms')
    await dms.loadLocalHistory()
    expect(dms.useDms.getState().conversations.peer.messages.map((m) => m.id)).toEqual(['b', 'c'])
    await vi.advanceTimersByTimeAsync(400)
    expect(saved.peer.map((m) => m.id)).toEqual(['b', 'c'])
    expect(saved.peer[0].expiresAt).toBe(NOW + 60_000)

    // A minute later (offline or not: the deadline is stored with the message).
    vi.setSystemTime(NOW + 61_000)
    dms.purgeExpiredDms()
    expect(dms.useDms.getState().conversations.peer.messages.map((m) => m.id)).toEqual(['c'])
    await vi.advanceTimersByTimeAsync(400)
    expect(saved.peer.map((m) => m.id)).toEqual(['c'])
    // A device link never carries one that's gone.
    expect(dms.exportHistory().peer.map((m) => m.id)).toEqual(['c'])
  })

  it('another copy with an earlier expiry (the server says sooner) wins', () => {
    const first = { id: 'x', from: 'p', sentAt: 1, expiresAt: 500 }
    expect(mergeDm([first], { ...first, expiresAt: 100 })[0].expiresAt).toBe(100)
    expect(mergeDm([first], { ...first, expiresAt: 900 })[0].expiresAt).toBe(500)
    expect(mergeDm<{ id: string; from: string; sentAt: number; expiresAt?: number }>([{ id: 'x', from: 'p', sentAt: 1 }], { ...first })[0].expiresAt).toBe(500)
  })

  it('the newest signed change line in a conversation sets its timer, with the servers', async () => {
    const { inBandTimer, dmSeconds } = await import('./disappearing')
    const lines = [
      { sentAt: 1, disappear: { seconds: 86400 } },
      { sentAt: 2 },
      { sentAt: 3, disappear: { seconds: 3600 }, error: "couldn't be read" },
    ]
    expect(inBandTimer(lines)).toBe(86400)
    expect(inBandTimer([...lines, { sentAt: 4, disappear: { seconds: 0 } }])).toBe(0)
    const state = { channels: {}, groups: {}, dms: { peer: { s1: { scope: 'dm' as const, accountKey: 'peer', seconds: 0, setBy: 'x', setAt: 0 } } } }
    // The server says off; the line someone signed says a day: a day.
    expect(dmSeconds(state, 'peer', [{ id: 'l', from: 'peer', to: 'me', text: '', sentAt: 1, disappear: { seconds: 86400 } }])).toBe(86400)
    expect(dmSeconds(state, 'peer', [])).toBe(0)
  })
})
