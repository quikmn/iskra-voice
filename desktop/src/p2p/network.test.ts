import assert from 'node:assert/strict'
import { test } from 'node:test'
import { p2pNetwork, parseBootstrap } from './network'

test('a packaged app joins the public DHT on the usual port, bound to every interface', () => {
  assert.deepEqual(p2pNetwork({}, true), { bind: '0.0.0.0', port: 49737, bootstrap: null })
  assert.deepEqual(p2pNetwork({ ISKRA_P2P_PORT: '50000' }, true), { bind: '0.0.0.0', port: 50000, bootstrap: null })
})

test('development builds and local-only runs never touch the network: loopback, and only a named testnet', () => {
  assert.deepEqual(p2pNetwork({}, false), { unavailable: 'no-network' })
  assert.deepEqual(p2pNetwork({ ISKRA_LOCAL_ONLY: '1' }, true), { unavailable: 'no-network' })
  assert.deepEqual(p2pNetwork({ ISKRA_LOCAL_ONLY: '1', ISKRA_P2P_BOOTSTRAP: 'public' }, true), { unavailable: 'no-network' })
  assert.deepEqual(p2pNetwork({ ISKRA_P2P_BOOTSTRAP: '127.0.0.1:40123' }, false), { bind: '127.0.0.1', port: 0, bootstrap: [{ host: '127.0.0.1', port: 40123 }] })
  assert.deepEqual(p2pNetwork({ ISKRA_LOCAL_ONLY: '1', ISKRA_P2P_BOOTSTRAP: '127.0.0.1:1,127.0.0.1:2', ISKRA_P2P_PORT: '0' }, true),
    { bind: '127.0.0.1', port: 0, bootstrap: [{ host: '127.0.0.1', port: 1 }, { host: '127.0.0.1', port: 2 }] })
})

test('the real test harness can name everything explicitly', () => {
  assert.deepEqual(p2pNetwork({ ISKRA_P2P_BIND: '0.0.0.0', ISKRA_P2P_BOOTSTRAP: 'public' }, false), { bind: '0.0.0.0', port: 49737, bootstrap: null })
  assert.deepEqual(p2pNetwork({ ISKRA_P2P_BIND: '0.0.0.0', ISKRA_P2P_BOOTSTRAP: 'node1.example.org:49737' }, false),
    { bind: '0.0.0.0', port: 49737, bootstrap: [{ host: 'node1.example.org', port: 49737 }] })
})

test('reads bootstrap lists and ignores junk', () => {
  assert.equal(parseBootstrap(undefined), null)
  assert.equal(parseBootstrap(''), null)
  assert.equal(parseBootstrap('public'), 'public')
  assert.deepEqual(parseBootstrap('[::1]:1234, 10.0.0.1:99999, nonsense'), [{ host: '::1', port: 1234 }])
  assert.equal(parseBootstrap('nonsense'), null)
})
