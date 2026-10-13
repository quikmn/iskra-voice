import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proxyV2Header } from './proxy'

const SIG = '0d0a0d0a000d0a515549540a'

test('writes a PROXY v2 header for an IPv4 friend', () => {
  const header = proxyV2Header({ address: '203.0.113.9', port: 4321 }, { address: '127.0.0.1', port: 47070 })
  assert.equal(header.length, 28)
  assert.equal(header.toString('hex'), `${SIG}2111000c` + 'cb007109' + '7f000001' + '10e1' + 'b7de')
})

test('writes an IPv6 header when either side is IPv6, mapping the IPv4 one', () => {
  const header = proxyV2Header({ address: '2001:db8::9', port: 5000 }, { address: '127.0.0.1', port: 47070 })
  assert.equal(header.length, 52)
  assert.equal(header.subarray(12, 16).toString('hex'), '21210024')
  assert.equal(header.subarray(16, 32).toString('hex'), '20010db8000000000000000000000009')
  assert.equal(header.subarray(32, 48).toString('hex'), '00000000000000000000ffff7f000001')
  assert.equal(header.subarray(48).toString('hex'), '1388b7de')
  // An IPv4-mapped source stays an IPv6 header with the mapped address.
  const mapped = proxyV2Header({ address: '::ffff:198.51.100.4', port: 1 }, { address: '::1', port: 2 })
  assert.equal(mapped.subarray(16, 32).toString('hex'), '00000000000000000000ffffc6336404')
})

test('an unknown source becomes 0.0.0.0:0', () => {
  const header = proxyV2Header(null, { address: '127.0.0.1', port: 1 })
  assert.equal(header.subarray(16, 20).toString('hex'), '00000000')
  assert.equal(header.subarray(24, 26).toString('hex'), '0000')
  assert.equal(proxyV2Header({ address: 'not-an-address', port: 7 }, { address: '127.0.0.1', port: 1 }).subarray(16, 20).toString('hex'), '00000000')
})
