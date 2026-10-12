import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inTailscaleRange, tailscaleAddress, tailscaleUrl } from './tailscale'

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal })

test('knows the shared range', () => {
  assert.equal(inTailscaleRange('100.64.0.1'), true)
  assert.equal(inTailscaleRange('100.127.255.254'), true)
  assert.equal(inTailscaleRange('100.63.255.255'), false)
  assert.equal(inTailscaleRange('100.128.0.1'), false)
  assert.equal(inTailscaleRange('192.168.1.20'), false)
  assert.equal(inTailscaleRange('100.64.0'), false)
})

test("finds Tailscale's adapter on each system", () => {
  // Windows
  assert.equal(tailscaleAddress({ Ethernet: [v4('192.168.1.20')], Tailscale: [v4('100.101.102.103')] }), '100.101.102.103')
  // Linux
  assert.equal(tailscaleAddress({ eth0: [v4('10.0.0.5')], tailscale0: [v4('100.88.1.2'), { address: 'fd7a:115c::1', family: 'IPv6', internal: false }] }), '100.88.1.2')
  // macOS (and older Node, which reports the family as a number)
  assert.equal(tailscaleAddress({ en0: [v4('192.168.0.3')], utun4: [{ address: '100.70.0.9', family: 4, internal: false }] }), '100.70.0.9')
  // The named adapter wins over another tunnel.
  assert.equal(tailscaleAddress({ utun2: [v4('100.90.0.1')], Tailscale: [v4('100.80.0.2')] }), '100.80.0.2')
})

test("a provider's shared address isn't Tailscale", () => {
  assert.equal(tailscaleAddress({ Ethernet: [v4('100.72.10.20')] }), null)
  assert.equal(tailscaleAddress({ eth0: [v4('100.72.10.20')] }), null)
  assert.equal(tailscaleAddress({ Tailscale: [v4('192.168.5.5')] }), null)
  assert.equal(tailscaleAddress({ Tailscale: [v4('100.100.100.100')] }), null)
  assert.equal(tailscaleAddress({ lo: [v4('127.0.0.1', true)] }), null)
  assert.equal(tailscaleAddress({}), null)
})

test('the invite address', () => {
  assert.equal(tailscaleUrl('100.101.102.103', 47070, false), 'http://100.101.102.103:47070')
  assert.equal(tailscaleUrl('100.101.102.103', 47070, true), null)
  assert.equal(tailscaleUrl(null, 47070, false), null)
})
