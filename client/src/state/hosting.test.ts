import { describe, expect, it } from 'vitest'
import type { HostPort, HostStatus } from '../core/protocol'
import { hostChecklist, hostSummary, inviteServerUrl, lanHost, manualForwards } from './hosting'

const port = (name: HostPort['name'], external: number, state: HostPort['state'], error: string | null = null): HostPort => ({
  name, protocol: name === 'voice-udp' ? 'udp' : 'tcp', internal: name.startsWith('voice') ? external : 47070, external, state, error,
})

function status(patch: Partial<HostStatus> = {}): HostStatus {
  return {
    enabled: true,
    lanUrl: 'http://192.168.1.20:47070',
    router: { state: 'found', kind: 'UPnP' },
    publicIp: '203.0.113.7',
    cgnat: false,
    ports: [port('acme', 80, 'open'), port('web', 443, 'open'), port('voice-tcp', 7881, 'open'), port('voice-udp', 7882, 'open')],
    address: '203-0-113-7.sslip.io',
    autoAddress: true,
    https: { state: 'valid', domain: '203-0-113-7.sslip.io', expiresAt: Date.UTC(2027, 0, 1), error: null },
    reachable: 'verified',
    publicUrl: 'https://203-0-113-7.sslip.io',
    checkedAt: 1,
    ...patch,
  }
}

const states = (s: HostStatus) => Object.fromEntries(hostChecklist(s).map((step) => [step.id, step.state]))

describe('internet hosting checklist', () => {
  it('is all done when everything worked', () => {
    expect(states(status())).toEqual({ router: 'done', ports: 'done', address: 'done', https: 'done', reachable: 'done' })
    expect(hostSummary(status()).tone).toBe('ok')
    expect(manualForwards(status())).toEqual([])
  })

  it('explains carrier-grade NAT', () => {
    const s = status({
      publicIp: '100.72.1.2', cgnat: true, address: null, publicUrl: null, reachable: 'unknown',
      ports: status().ports.map((p) => ({ ...p, state: 'skipped' as const })),
      https: { state: 'waiting', domain: null, expiresAt: null, error: null },
    })
    expect(states(s)).toMatchObject({ ports: 'problem', address: 'problem' })
    expect(hostSummary(s).tone).toBe('warn')
    expect(manualForwards(s)).toEqual([])
  })

  it('lists exact forwards when the router has no UPnP', () => {
    const s = status({
      router: { state: 'not_found', kind: null }, publicIp: null, address: null, publicUrl: null, reachable: 'unknown',
      ports: [port('acme', 80, 'manual'), port('web', 443, 'manual'), port('voice-tcp', 7881, 'manual'), port('voice-udp', 7882, 'manual')],
      https: { state: 'waiting', domain: null, expiresAt: null, error: null },
    })
    expect(states(s).router).toBe('problem')
    expect(manualForwards(s)).toEqual([
      { external: 80, internal: 47070, protocol: 'TCP', purpose: 'certificate check' },
      { external: 443, internal: 47070, protocol: 'TCP', purpose: 'the server' },
      { external: 7881, internal: 7881, protocol: 'TCP', purpose: 'voice' },
      { external: 7882, internal: 7882, protocol: 'UDP', purpose: 'voice' },
    ])
    expect(lanHost(s)).toBe('192.168.1.20')
  })

  it('is honest when only port 80 was refused', () => {
    const s = status({
      ports: [port('acme', 80, 'failed', "The router doesn't allow opening this port."), { ...port('web', 47070, 'open') },
        port('voice-tcp', 7881, 'open'), port('voice-udp', 7882, 'open')],
      https: { state: 'needs_port_80', domain: '203-0-113-7.sslip.io', expiresAt: null, error: null },
      publicUrl: 'http://203.0.113.7:47070', reachable: 'unknown',
    })
    expect(states(s)).toMatchObject({ ports: 'problem', https: 'problem', reachable: 'todo' })
    expect(hostSummary(s).text).toMatch(/desktop app only/)
    expect(manualForwards(s)).toEqual([{ external: 80, internal: 47070, protocol: 'TCP', purpose: 'certificate check' }])
    expect(hostChecklist(s).find((x) => x.id === 'reachable')!.detail).toMatch(/Not confirmed/)
  })

  it('says off when off', () => {
    expect(hostSummary(status({ enabled: false })).tone).toBe('off')
  })
})

describe('invite address', () => {
  it('prefers the public address', () => {
    expect(inviteServerUrl({ url: 'http://localhost:47070', publicUrl: 'https://203-0-113-7.sslip.io' })).toBe('https://203-0-113-7.sslip.io')
    expect(inviteServerUrl({ url: 'http://192.168.1.20:47070', publicUrl: null })).toBe('http://192.168.1.20:47070')
  })
})
