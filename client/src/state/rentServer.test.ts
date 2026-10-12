import sodium from 'libsodium-wrappers-sumo'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { b64u, fromB64u, ready } from '../core/crypto'
import { RELEASE_VERSION } from '../links'
import { checkClaimProof, claimCode, cloudInit, forgetPending, loadPending, newClaim, rememberPending, vpsAddress, vpsPrompt, waitForClaim } from './rentServer'

// The encrypted store (core/storage.ts seals these slots with the vault key), in memory: what got written where.
const sealed = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../core/storage', () => ({
  savePendingRent: vi.fn(async (value: unknown) => void sealed.set('rent-pending', value)),
  loadPendingRent: vi.fn(async () => sealed.get('rent-pending')),
  clearPendingRent: vi.fn(async () => void sealed.delete('rent-pending')),
}))

// Node has no localStorage of its own: a recording one, to prove nothing goes there.
const local = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v),
  removeItem: (k: string) => void local.delete(k), clear: () => local.clear(), key: () => null, get length() { return local.size },
})

// bash -n on the setup text: skipped (visibly) only on Windows without bash; anywhere else a missing bash fails.
type Spawn = (cmd: string, args: string[], o?: object) => { status: number | null; stderr: { toString(): string } }
const { spawnSync } = (await import(/* @vite-ignore */ 'node:child_process' as string)) as { spawnSync: Spawn }
const platform = (globalThis as { process?: { platform?: string } }).process?.platform
const hasBash = spawnSync('bash', ['--version']).status === 0

// The server's side (OwnerSetup.cs): HMAC-SHA-256 with context strings. Fixed vectors (also in OwnerClaimTests.cs)
// keep the app and the server in agreement; these helpers make proofs for random claims.
const enc = (s: string) => new TextEncoder().encode(s)
const serverCode = (claim: string) => b64u(sodium.crypto_auth_hmacsha256(enc('iskra-owner-invite-v1'), fromB64u(claim)).subarray(0, 16))
const serverProof = (claim: string, key: string, nonce: string) =>
  b64u(sodium.crypto_auth_hmacsha256(enc(`iskra-owner-proof-v1\n${key}\n${nonce}`), fromB64u(claim)))
const VECTOR = {
  claim: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', // bytes 0..31
  code: 'TZ9bbtMv6iMikMJTX8_QOQ',
  key: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  nonce: 'nonce-nonce-nonce',
  proof: 'A8ULBj4p678ZDj9e_x-eIr1eOXIkjW_2rRmzmRyZXeM',
}

describe('rent a small server: the setup text', () => {
  it('installs the pinned release only after checking its checksum', async () => {
    const claim = await newClaim()
    const script = cloudInit({ name: 'Game Night', template: 'gaming', claim })
    expect(script.startsWith('#!/bin/bash\n')).toBe(true)
    expect(script).toContain('set -euo pipefail')
    expect(script).toContain(`VERSION="${RELEASE_VERSION}"`)
    expect(script).toContain(`PACKAGE="iskra-server-${RELEASE_VERSION}-linux-x64.tar.gz"`)
    expect(script).toContain('BASE="https://github.com/quikmn/iskra-voice/releases/download/v$VERSION"')
    expect(script).toContain('"$BASE/SHA256SUMS.txt"')
    expect(script).toContain("--proto '=https'")
    // The checksum is checked before the package is unpacked.
    expect(script.indexOf('sha256sum -c')).toBeGreaterThan(0)
    expect(script.indexOf('sha256sum -c')).toBeLessThan(script.indexOf('tar -xzf'))
    // Only the ports Iskra needs (and SSH), then the firewall goes on.
    expect(script.match(/^ufw allow .*$/gm)).toEqual(['ufw allow 22/tcp', 'ufw allow 80/tcp', 'ufw allow 443/tcp', 'ufw allow 7881/tcp', 'ufw allow 7882/udp'])
    expect(script).toContain('ufw --force enable')
    expect(script).toContain('User=iskra')
    expect(script).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
    expect(script).toContain('systemctl enable --now iskra')
  })

  it('writes server.json with HTTPS on and the owner claim as the only secret', async () => {
    const claim = await newClaim()
    const script = cloudInit({ name: 'It\'s "$(rm -rf /)" `night`', template: 'friends', claim })
    const json = script.split("<<'ISKRA_SERVER_JSON'\n")[1].split('\nISKRA_SERVER_JSON\n')[0]
    const settings = JSON.parse(json.replace('__DOMAIN__', '203-0-113-7.sslip.io'))
    expect(settings).toEqual({
      Name: 'It\'s "$(rm -rf /)" `night`', Template: 'friends', OwnerClaim: claim,
      Https: { Mode: 'acme', Domain: '203-0-113-7.sslip.io' }, Voice: { Enabled: true, RtcTcpPort: 7881, RtcUdpPort: 7882 }, Updates: { Mode: 'auto' },
    })
    // The claim appears once; nothing else in the text looks like a key.
    expect(script.split(claim)).toHaveLength(2)
    expect(script.replace(claim, '').match(/[A-Za-z0-9_-]{32,}/g)).toBe(null)
    // A bad template id is left out rather than passed along.
    expect(cloudInit({ name: 'x', template: '../../etc', claim })).not.toContain('Template')
    expect(() => cloudInit({ name: 'x', template: null, claim: 'short' })).toThrow()
  })

  it.skipIf(platform === 'win32' && !hasBash)('is valid bash', async () => {
    const script = cloudInit({ name: 'Game Night', template: 'gaming', claim: await newClaim() })
    const result = spawnSync('bash', ['-n'], { input: script })
    expect(result.stderr.toString()).toBe('')
    expect(result.status).toBe(0)
  })

  it('turns a public IPv4 address into the server address, and nothing else', () => {
    expect(vpsAddress(' 203.0.113.7 ')).toBe('https://203-0-113-7.sslip.io')
    for (const bad of ['192.168.1.2', '10.0.0.1', '100.64.1.1', '127.0.0.1', '1.2.3', '1.2.3.400', 'example.com', '2001:db8::1']) expect(vpsAddress(bad)).toBe(null)
  })

  it('has a plan B prompt without secrets', () => {
    const prompt = vpsPrompt()
    expect(prompt).toContain(`iskra-server-${RELEASE_VERSION}-linux-x64.tar.gz`)
    expect(prompt).toContain('SHA256SUMS.txt')
    expect(prompt).toContain('7882/UDP')
    expect(prompt).not.toMatch(/OwnerClaim|[A-Za-z0-9_-]{32,}/)
  })
})

describe('rent a small server: claiming it', () => {
  it('derives the same owner code and proof as the server', async () => {
    await ready()
    expect(await claimCode(VECTOR.claim)).toBe(VECTOR.code)
    expect(await checkClaimProof(VECTOR.claim, VECTOR.key, VECTOR.nonce, VECTOR.proof)).toBe(true)
    const claim = await newClaim()
    expect(await claimCode(claim)).toBe(serverCode(claim))
    const key = b64u(new Uint8Array(32).fill(7))
    expect(await checkClaimProof(claim, key, 'nonce-nonce-nonce', serverProof(claim, key, 'nonce-nonce-nonce'))).toBe(true)
    expect(await checkClaimProof(claim, key, 'another-nonce-123', serverProof(claim, key, 'nonce-nonce-nonce'))).toBe(false)
    expect(await checkClaimProof(await newClaim(), key, 'nonce-nonce-nonce', serverProof(claim, key, 'nonce-nonce-nonce'))).toBe(false)
    expect(await checkClaimProof(claim, key, 'nonce-nonce-nonce', 'garbage!')).toBe(false)
  })

  it('waits for the server, then returns the owner invite', async () => {
    const claim = await newClaim()
    const key = b64u(new Uint8Array(32).fill(9))
    let calls = 0
    const seen: string[] = []
    const fetcher = (async (url: string) => {
      calls++
      if (calls < 3) throw new TypeError('not up yet')
      const nonce = new URL(url).searchParams.get('nonce')!
      expect(url.startsWith('https://203-0-113-7.sslip.io/.well-known/iskra-claim?nonce=')).toBe(true)
      return new Response(JSON.stringify({ iskra: 1, key, proof: serverProof(claim, key, nonce) }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await waitForClaim('203.0.113.7', claim, { fetcher, intervalMs: 1, onProgress: (p) => seen.push(p) })
    expect(result.invite).toEqual({ serverUrl: 'https://203-0-113-7.sslip.io', serverKey: key, code: serverCode(claim) })
    expect(seen.slice(-2)).toEqual(['checking', 'joining'])
  })

  it('refuses a server that can\'t prove it holds the claim, and gives up in time', async () => {
    const claim = await newClaim()
    const impostor = (async () => new Response(JSON.stringify({ key: 'x', proof: 'y' }), { status: 200 })) as unknown as typeof fetch
    await expect(waitForClaim('203.0.113.7', claim, { fetcher: impostor, intervalMs: 1 })).rejects.toThrow(/isn't the one set up/)
    const down = (async () => { throw new TypeError('down') }) as unknown as typeof fetch
    await expect(waitForClaim('203.0.113.7', claim, { fetcher: down, intervalMs: 5, timeoutMs: 20 })).rejects.toThrow(/didn't answer within 20 minutes/)
    await expect(waitForClaim('192.168.1.5', claim, { fetcher: down })).rejects.toThrow(/public IPv4/)
  })
})

describe('rent a small server: the pending owner key', () => {
  beforeEach(() => {
    sealed.clear()
    local.clear()
  })

  it('is kept in the encrypted store until the server is claimed, never in localStorage', async () => {
    const claim = await newClaim()
    await rememberPending({ name: 'Game Night', template: 'gaming', claim, ip: '203.0.113.7' })
    expect(sealed.get('rent-pending')).toEqual({ name: 'Game Night', template: 'gaming', claim, ip: '203.0.113.7' })
    // Closing and reopening the dialog finds it again.
    expect((await loadPending())?.claim).toBe(claim)

    const key = b64u(new Uint8Array(32).fill(3))
    const fetcher = (async (url: string) => {
      const nonce = new URL(url).searchParams.get('nonce')!
      return new Response(JSON.stringify({ iskra: 1, key, proof: serverProof(claim, key, nonce) }), { status: 200 })
    }) as unknown as typeof fetch
    await waitForClaim('203.0.113.7', claim, { fetcher, intervalMs: 1 })
    expect(sealed.has('rent-pending')).toBe(false)
    expect(await loadPending()).toBe(null)
    expect(local.size).toBe(0)
  })

  it('is deleted when the user starts over, and a bad one is ignored', async () => {
    await rememberPending({ name: 'x', template: 'gaming', claim: await newClaim(), ip: '' })
    await forgetPending()
    expect(sealed.has('rent-pending')).toBe(false)
    await rememberPending({ name: 'x', template: 'gaming', claim: 'not-a-claim', ip: '' })
    expect(sealed.has('rent-pending')).toBe(false)
    sealed.set('rent-pending', { name: 'x', template: 'gaming', claim: 'tampered', ip: '' })
    expect(await loadPending()).toBe(null)
    expect(local.size).toBe(0)
  })
})
