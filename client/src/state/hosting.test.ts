import { describe, expect, it } from 'vitest'
import type { HostPort, HostStatus } from '../core/protocol'
import { aiPrompt, cgnatAdvice, forwardRows, hostChecklist, hostSummary, inviteServerUrl, lanHost, manualForwards, routerPage } from './hosting'
import type { HostedServer } from '../platform/desktop'

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
      publicUrl: null, reachable: 'unknown',
    })
    expect(states(s)).toMatchObject({ ports: 'problem', https: 'problem', reachable: 'todo' })
    expect(hostSummary(s).text).toMatch(/^Waiting for HTTPS/)
    expect(manualForwards(s)).toEqual([{ external: 80, internal: 47070, protocol: 'TCP', purpose: 'certificate check' }])
    expect(hostChecklist(s).find((x) => x.id === 'reachable')!.detail).toMatch(/Not confirmed/)
  })

  it('waits for HTTPS, and warns about a plain HTTP address forced in server.json', () => {
    const waiting = status({ publicUrl: null, reachable: 'unknown', https: { state: 'requesting', domain: '203-0-113-7.sslip.io', expiresAt: null, error: null } })
    expect(hostSummary(waiting)).toEqual({ tone: 'busy', text: 'Waiting for HTTPS…' })
    const forced = status({ publicUrl: 'http://203.0.113.7:47070', https: { state: 'needs_port_80', domain: '203-0-113-7.sslip.io', expiresAt: null, error: null } })
    expect(hostSummary(forced).tone).toBe('warn')
    expect(hostSummary(forced).text).toMatch(/plain HTTP/)
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

describe('a server hosted on this computer', () => {
  it('invites friends to its address on the network, not localhost', () => {
    const hosted = { id: 'game-night', localUrl: 'http://localhost:47071', lanUrl: 'http://192.168.1.20:47071' } as HostedServer
    const byUrl = { [hosted.localUrl]: hosted }
    expect(inviteServerUrl({ url: 'http://localhost:47071', publicUrl: null }, byUrl)).toBe('http://192.168.1.20:47071')
    expect(inviteServerUrl({ url: 'http://localhost:47071', publicUrl: 'https://203-0-113-7.sslip.io' }, byUrl)).toBe('https://203-0-113-7.sslip.io')
    expect(inviteServerUrl({ url: 'http://localhost:9999', publicUrl: null }, byUrl)).toBe('http://localhost:9999')
  })
})

describe('port forwarding help', () => {
  const noRouter = () => status({
    router: { state: 'not_found', kind: null, model: null }, publicIp: null, nat: null, address: null, publicUrl: null, reachable: 'unknown',
    ports: status().ports.map((p) => ({ ...p, state: 'manual' as const })),
    lanIp: '192.168.1.20', gateway: '192.168.1.1', os: 'windows',
    https: { state: 'waiting', domain: null, expiresAt: null, error: null },
  })

  it('lists every port with its protocol, voice included', () => {
    expect(forwardRows(noRouter())).toEqual([
      { external: 80, internal: 47070, protocol: 'TCP', purpose: 'certificate check' },
      { external: 443, internal: 47070, protocol: 'TCP', purpose: 'the server' },
      { external: 7881, internal: 7881, protocol: 'TCP', purpose: 'voice' },
      { external: 7882, internal: 7882, protocol: 'UDP', purpose: 'voice' },
    ])
    // Everything open: still the full list (for "Show me how").
    expect(forwardRows(status())).toHaveLength(4)
  })

  it('links only a private router address', () => {
    expect(routerPage(noRouter())).toBe('http://192.168.1.1')
    expect(routerPage(status({ gateway: '8.8.8.8' }))).toBe(null)
    expect(routerPage(status({ gateway: 'javascript:alert(1)' }))).toBe(null)
    expect(routerPage(status({ gateway: null }))).toBe(null)
  })

  it('builds an AI prompt with local details and never the public address', () => {
    const s = status({ router: { state: 'found', kind: 'UPnP', model: 'TP-Link Archer AX55' }, ports: noRouter().ports, lanIp: '192.168.1.20', gateway: '192.168.1.1', os: 'windows' })
    const prompt = aiPrompt(s)
    expect(prompt).toContain('Server computer: Windows')
    expect(prompt).toContain('Router: TP-Link Archer AX55')
    expect(prompt).toContain('(gateway): 192.168.1.1')
    expect(prompt).toContain('on my network: 192.168.1.20')
    expect(prompt).toContain('- outside port 7882 UDP to port 7882 (voice)')
    expect(prompt).toContain('- outside port 443 TCP to port 47070 (the server)')
    for (const secret of ['203.0.113.7', '203-0-113-7', 'sslip', 'https://', '#/join']) expect(prompt).not.toContain(secret)
    expect(aiPrompt(status({ router: { state: 'not_found', kind: null }, lanUrl: null, lanIp: null, gateway: null, os: undefined }))).toContain('Router: unknown')
  })

  it('knows when to explain a shared connection', () => {
    expect(cgnatAdvice(status())).toBe(null)
    expect(cgnatAdvice(status({ cgnat: true, nat: 'cgnat' }))).toBe('shared')
    expect(cgnatAdvice(status({ nat: 'private' }))).toBe('maybe')
    expect(cgnatAdvice(noRouter())).toBe('maybe')
    expect(cgnatAdvice(status({ enabled: false, cgnat: true }))).toBe(null)
  })
})
