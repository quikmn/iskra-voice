// Muting several servers at once: one notify.set per server, each on its own connection; a server that is offline
// fails on its own and the others are still muted.
import { beforeEach, describe, expect, it } from 'vitest'
import { muteServers, useOrganize } from './organize'
import { splitSettled } from './organizeLogic'
import { setConnectionForTests } from './store'

describe('muting several servers', () => {
  const sent: [string, string, Record<string, unknown>][] = []

  beforeEach(() => {
    sent.length = 0
    useOrganize.setState({ notify: {} })
    for (const key of ['a', 'b']) {
      setConnectionForTests(key, {
        isOnline: true,
        request: (async (type: string, body: { channelId: number | null; muteMinutes: number }) => {
          sent.push([key, type, body])
          return { setting: { channelId: null, level: 'default', mutedUntil: body.muteMinutes === 0 ? null : body.muteMinutes === -1 ? -1 : 1_000_000 } }
        }) as never,
      })
    }
    setConnectionForTests('down', { isOnline: false, request: (async () => { throw new Error('disconnected') }) as never })
    setConnectionForTests('gone', null)
  })

  it('sorts results into done and failed', () => {
    expect(splitSettled(['a', 'b'], [{ status: 'fulfilled', value: 1 }, { status: 'rejected', reason: 'x' }])).toEqual({ done: ['a'], failed: ['b'] })
    expect(splitSettled([], [])).toEqual({ done: [], failed: [] })
  })

  it('mutes each server once with the same duration and keeps what each answered', async () => {
    const result = await muteServers(['a', 'b', 'a'], 480)
    expect(result).toEqual({ done: ['a', 'b'], failed: [] })
    expect(sent).toEqual([
      ['a', 'notify.set', { channelId: null, muteMinutes: 480 }],
      ['b', 'notify.set', { channelId: null, muteMinutes: 480 }],
    ])
    expect(useOrganize.getState().notify.a.server.mutedUntil).toBe(1_000_000)
    expect(useOrganize.getState().notify.b.server.mutedUntil).toBe(1_000_000)
  })

  it('says which servers could not be reached and still mutes the rest', async () => {
    const result = await muteServers(['a', 'down', 'gone'], -1)
    expect(result).toEqual({ done: ['a'], failed: ['down', 'gone'] })
    expect(useOrganize.getState().notify.a.server.mutedUntil).toBe(-1)
    expect(useOrganize.getState().notify.down).toBeUndefined()
  })

  it('unmutes with 0', async () => {
    await muteServers(['a'], 60)
    await muteServers(['a'], 0)
    expect(useOrganize.getState().notify.a.server.mutedUntil).toBeNull()
  })
})
