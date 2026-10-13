import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HostTunnels, readWorldP2p } from './hostTunnel'
import { P2pNode } from './node'

const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url')

function world(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'iskra-p2p-world-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

test("reads a world's p2p files: on only with the secret and the listener's port", () => {
  const off = world({ 'server.json': JSON.stringify({ Name: 'x' }) })
  assert.deepEqual(readWorldP2p(off), { enabled: false, secret: null, tunnelPort: null, turnPort: 7883 })
  const on = world({ 'server.json': JSON.stringify({ P2p: { Enabled: true }, Voice: { RtcUdpPort: 7992 } }), 'p2p.key': `${secret}\n`, 'p2p.port': '51234\n' })
  const read = readWorldP2p(on)
  assert.equal(read.enabled, true)
  assert.equal(read.secret?.toString('base64url'), secret)
  assert.equal(read.tunnelPort, 51234)
  assert.equal(read.turnPort, 7993)
  const explicit = world({ 'server.json': JSON.stringify({ P2p: { Enabled: true }, Voice: { TurnUdpPort: 8000 } }), 'p2p.key': 'not a key', 'p2p.port': 'soon' })
  assert.deepEqual(readWorldP2p(explicit), { enabled: true, secret: null, tunnelPort: null, turnPort: 8000 })
  assert.equal(readWorldP2p(world({ 'server.json': JSON.stringify({ Voice: { Enabled: false } }) })).turnPort, null)
  assert.equal(readWorldP2p(world({ 'server.json': '{ not json' })).enabled, false)
  for (const dir of [off, on, explicit]) rmSync(dir, { recursive: true, force: true })
})

test('without a network to join the tunnel says so instead of starting', async () => {
  const changes: string[] = []
  const tunnels = new HostTunnels(new P2pNode({ unavailable: 'no-network' }), (id, s) => changes.push(`${id}:${s.state}`))
  const dir = world({ 'server.json': JSON.stringify({ P2p: { Enabled: true } }), 'p2p.key': `${secret}\n`, 'p2p.port': '51234\n' })
  const status = await tunnels.sync('living-room', dir)
  assert.equal(status.state, 'unavailable')
  assert.equal(status.error, 'no-network')
  assert.equal(status.hostKey, '71b61f4c35ce6e8f87eb58793b6fcdcebf6a42b7435f70f2b4c6fab4b541ae30')
  assert.deepEqual(changes, ['living-room:starting', 'living-room:unavailable'])
  // Off in the world: the status is plain off, and nothing to stop.
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ P2p: { Enabled: false } }))
  assert.equal((await tunnels.sync('living-room', dir)).state, 'off')
  assert.equal(tunnels.status('nothing').state, 'off')
  rmSync(dir, { recursive: true, force: true })
})
