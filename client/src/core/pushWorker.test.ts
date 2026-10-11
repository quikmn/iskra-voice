// Runs the real public/push-sw.js against a fake service worker scope.
import { describe, expect, it, vi } from 'vitest'
import SOURCE from '../../public/push-sw.js?raw'

const SERVER = 'S'.repeat(43)
const PEER = 'p'.repeat(43)
const ORIGIN = 'https://app.iskra.foo'

interface FakeClient {
  url: string
  postMessage: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

function worker(windows: FakeClient[] = []) {
  const listeners: Record<string, (event: unknown) => void> = {}
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const self = {
    location: new URL(`${ORIGIN}/push-sw.js`),
    registration: {
      scope: `${ORIGIN}/push/${SERVER}/`,
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => void shown.push({ title, options })),
      pushManager: { subscribe: vi.fn(async () => ({})) },
    },
    clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
    addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
    skipWaiting: vi.fn(),
  }
  new Function('self', SOURCE)(self)

  async function dispatch(type: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve()
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) })
    await pending
  }
  const push = (data: unknown) => dispatch('push', { data: { json: () => data } })
  const click = (route: string) => dispatch('notificationclick', { notification: { data: { route }, close: vi.fn() } })
  return { self, shown, push, click }
}

const mention = { v: 1, kind: 'mention', server: SERVER, title: 'Alice in #general', body: 'hey @Bob', tag: 'c:7', channelId: 7, count: 1, at: 1 }

describe('push service worker', () => {
  it('shows a mention with a tag per server and conversation, opening that channel', async () => {
    const w = worker()
    await w.push(mention)
    expect(w.shown).toHaveLength(1)
    const [{ title, options }] = w.shown
    expect(title).toBe('Alice in #general')
    expect(options.body).toBe('hey @Bob')
    expect(options.tag).toBe(`${SERVER}:c:7`)
    expect(options.data).toEqual({ route: `/open/${SERVER}/c/7` })
    expect(options.icon).toBe(`${ORIGIN}/icons/icon-192.png`)
  })

  it('routes DMs to the conversation and keeps calls on screen', async () => {
    const w = worker()
    await w.push({ ...mention, kind: 'dm', title: 'New message from Alice', body: 'Open Iskra to read it.', tag: `dm:${PEER}`, channelId: null, peer: PEER })
    await w.push({ ...mention, kind: 'call', title: 'Alice is calling', channelId: null, peer: PEER })
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}/dm/${PEER}` })
    expect(w.shown[1].options.requireInteraction).toBe(true)
  })

  it('routes group messages and group calls to the group', async () => {
    const w = worker()
    const group = 'g'.repeat(21) + '_'
    await w.push({ ...mention, kind: 'group', title: 'New message from Alice', tag: `g:${group}`, channelId: null, group })
    await w.push({ ...mention, kind: 'call', title: 'Alice started a group call', channelId: null, group })
    await w.push({ ...mention, kind: 'group', channelId: null, group: '../../evil' })
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}/g/${group}` })
    expect(w.shown[1].options.requireInteraction).toBe(true)
    expect(w.shown[2].options.data).toEqual({ route: `/open/${SERVER}` })
  })

  it('routes reminders to the reminder (its content is sealed, so the app opens it)', async () => {
    const w = worker()
    await w.push({ ...mention, kind: 'reminder', title: 'Reminder', tag: 'reminder:5', channelId: 7, reminder: 5 })
    await w.push({ ...mention, kind: 'reminder', title: 'Reminder', tag: 'reminder:6', channelId: null, reminder: 'x' })
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}/r/5` })
    expect(w.shown[1].options.data).toEqual({ route: `/open/${SERVER}` })
  })

  it('falls back to a generic notification for anything unexpected', async () => {
    const w = worker()
    await w.push({ ...mention, server: 'X'.repeat(43) }) // another server's payload in this registration
    await w.push({ v: 2 })
    await w.push(null)
    expect(w.shown).toHaveLength(3)
    for (const n of w.shown) {
      expect(n.title).toBe('Iskra')
      expect(n.options.data).toEqual({ route: '/' })
    }
  })

  it('clips long text and ignores routes it cannot vouch for', async () => {
    const w = worker()
    await w.push({ ...mention, title: 'x'.repeat(500), body: 'y'.repeat(5000), channelId: '7; evil', peer: '../../x' })
    expect(w.shown[0].title.length).toBe(120)
    expect((w.shown[0].options.body as string).length).toBe(300)
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}` })
  })

  it('focuses an open app window and tells it where to go', async () => {
    const app = { url: `${ORIGIN}/`, postMessage: vi.fn(), focus: vi.fn(async () => undefined) }
    const w = worker([app])
    await w.click(`/open/${SERVER}/c/7`)
    expect(app.postMessage).toHaveBeenCalledWith({ type: 'iskra.open', route: `/open/${SERVER}/c/7` })
    expect(app.focus).toHaveBeenCalled()
    expect(w.self.clients.openWindow).not.toHaveBeenCalled()
  })

  it('opens a new window at the route when Iskra is closed', async () => {
    const w = worker()
    await w.click(`/open/${SERVER}/dm/${PEER}`)
    expect(w.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/#/open/${SERVER}/dm/${PEER}`)
  })
})
