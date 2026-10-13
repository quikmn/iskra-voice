// The tunnel on one machine, everything bound to 127.0.0.1: a private HyperDHT testnet stands in for the public one.
// Proves the lookup, the friend-key gate, TCP forwarding with the PROXY header, and datagram forwarding; not NAT
// traversal (loopback peers are "open" and never punch).
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import net from 'node:net'
import { after, before, test } from 'node:test'
import DHT from 'hyperdht'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { friendKeyPair, hostKeyPair, onlyFriends } from './keys'
import { openTunnel, serveTunnel, type FriendTunnel, type HostTunnel } from './tunnel'

const LOCAL = '127.0.0.1'
const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i))

let testnet: Testnet
let hostDht: DHT
let friendDht: DHT
let strangerDht: DHT
let echo: net.Server
let udpEcho: dgram.Socket
let host: HostTunnel
let friend: FriendTunnel
/** What the local "server" saw at the start of each connection (the PROXY header). */
const seenHeaders: Buffer[] = []

before(async () => {
  testnet = await createTestnet(3, { host: LOCAL })
  const node = () => new DHT({ bootstrap: testnet.bootstrap, host: LOCAL, ephemeral: true })
  hostDht = node()
  friendDht = node()
  strangerDht = node()
  // A TCP echo that records the first 28 bytes (the IPv4 PROXY header), and a UDP echo.
  echo = net.createServer((sock) => {
    let head = Buffer.alloc(0)
    sock.on('data', (d: Buffer) => {
      if (head.length < 28) {
        const take = d.subarray(0, 28 - head.length)
        head = Buffer.concat([head, take])
        d = d.subarray(take.length)
        if (head.length === 28) seenHeaders.push(head)
      }
      if (d.length) sock.write(d)
    })
  })
  await new Promise<void>((r) => echo.listen(0, LOCAL, r))
  udpEcho = dgram.createSocket('udp4')
  udpEcho.on('message', (m, rinfo) => udpEcho.send(Buffer.concat([Buffer.from('echo:'), m]), rinfo.port, rinfo.address))
  await new Promise<void>((r) => udpEcho.bind(0, LOCAL, r))

  host = await serveTunnel(hostDht, hostKeyPair(secret), { web: (echo.address() as net.AddressInfo).port, turn: (udpEcho.address() as net.AddressInfo).port }, { allow: onlyFriends(secret) })
  friend = await openTunnel(friendDht, host.publicKey, { web: 0, turn: 0 }, { keyPair: friendKeyPair(secret) })
})

after(async () => {
  friend?.close()
  await host?.close()
  echo?.close()
  udpEcho?.close()
  await Promise.all([hostDht?.destroy(), friendDht?.destroy(), strangerDht?.destroy()])
  await testnet?.destroy()
})

test('TCP goes through, introduced by a PROXY header naming the friend', async () => {
  const sock = net.connect({ host: LOCAL, port: friend.ports.web })
  await new Promise<void>((r) => sock.once('connect', r))
  const started = performance.now()
  sock.write('hello tunnel')
  const reply = await new Promise<string>((r) => sock.once('data', (d) => r(d.toString())))
  const ms = performance.now() - started
  assert.equal(reply, 'hello tunnel')
  sock.destroy()
  assert.equal(seenHeaders.length, 1)
  const header = seenHeaders[0]
  assert.equal(header.subarray(0, 12).toString('hex'), '0d0a0d0a000d0a515549540a')
  assert.equal(header.subarray(12, 16).toString('hex'), '2111000c')
  assert.equal(header.subarray(16, 20).join('.'), '127.0.0.1') // the friend's DHT socket, as the host saw it
  assert.ok(header.readUInt16BE(24) > 0)
  assert.ok(friend.timings.length >= 1)
  console.log(`tunnel: first TCP round trip ${ms.toFixed(1)} ms, DHT connection ${friend.timings[0].toFixed(1)} ms`)
})

test('datagrams go through as unreliable messages', async () => {
  const sock = dgram.createSocket('udp4')
  await new Promise<void>((r) => sock.bind(0, LOCAL, r))
  const got: string[] = []
  sock.on('message', (m) => got.push(m.toString()))
  // The first datagram waits for the DHT connection; later ones should go straight through.
  for (let i = 0; i < 5; i++) {
    sock.send(`d${i}`, friend.ports.turn!, LOCAL)
    await new Promise((r) => setTimeout(r, i === 0 ? 300 : 20))
  }
  for (let i = 0; i < 50 && got.length < 5; i++) await new Promise((r) => setTimeout(r, 50))
  sock.close()
  assert.deepEqual(got.sort(), ['echo:d0', 'echo:d1', 'echo:d2', 'echo:d3', 'echo:d4'])
})

test('a peer that knows the host key but not the secret is refused before any data flows', async () => {
  const stream = strangerDht.connect(host.publicKey) // its own random key pair
  const outcome = await new Promise<string>((r) => {
    stream.once('open', () => r('open'))
    stream.once('error', (e) => r(`error: ${e.message}`))
    stream.once('close', () => r('closed'))
  })
  assert.notEqual(outcome, 'open')
  stream.destroy()
})

test('the host only offers its fixed services', async () => {
  const stream = friendDht.connect(host.publicKey, { keyPair: friendKeyPair(secret) })
  stream.on('error', () => undefined)
  await new Promise<void>((r) => stream.once('open', r))
  stream.write(Buffer.from([9])) // not a service
  // The host drops it; the friend sees the reset within the connection's keep-alive window.
  const closed = await new Promise<boolean>((r) => {
    stream.once('close', () => r(true))
    setTimeout(() => r(false), 15_000)
  })
  assert.equal(closed, true)
})
