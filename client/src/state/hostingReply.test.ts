import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostStatus } from '../core/protocol'

const listeners: ((key: string, type: string, body: unknown) => void)[] = []
vi.mock('./store', () => ({
  useApp: { getState: () => ({ servers: {} }), setState: () => undefined },
  connectionFor: () => undefined,
  onServerEvent: (l: (key: string, type: string, body: unknown) => void) => listeners.push(l),
}))

const { fromReply, useHosting } = await import('./hosting')

const status = (routerState: string, ports: HostStatus['ports'] = []): HostStatus => ({
  enabled: true, lanUrl: null, router: { state: routerState, kind: null, model: null }, publicIp: null, cgnat: false, ports,
  address: null, autoAddress: false, https: { state: 'off' }, reachable: 'unknown', publicUrl: null, checkedAt: 1,
} as unknown as HostStatus)

const event = (key: string, s: HostStatus) => listeners.forEach((l) => l(key, 'host.status', { status: s }))
const manual = [{ name: 'web', protocol: 'tcp', internal: 1, external: 1, state: 'manual' }] as HostStatus['ports']

describe('host status from a reply', () => {
  beforeEach(() => useHosting.setState({ status: {} }))

  it('applies the reply when no event came meanwhile', async () => {
    await fromReply('a', async () => ({ status: status('searching') }))
    expect(useHosting.getState().status.a.router.state).toBe('searching')
  })

  it("keeps an event that came while the request was out: the reply's copy may be older", async () => {
    // Regression (hosting.spec on CI): the server read the reply's status mid-way through its hosting check (router
    // not found, ports not set yet) and the check's own event, complete, went out first.
    const result = await fromReply('b', async () => {
      event('b', status('not_found', manual))
      return { status: status('not_found') }
    })
    expect(useHosting.getState().status.b.ports).toHaveLength(1)
    expect(result.ports).toHaveLength(1)
  })

  it("an event for another server doesn't block the reply", async () => {
    await fromReply('c', async () => {
      event('d', status('found'))
      return { status: status('not_found') }
    })
    expect(useHosting.getState().status.c.router.state).toBe('not_found')
  })
})
