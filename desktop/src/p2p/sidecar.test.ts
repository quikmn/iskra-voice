// iskra-p2p (the standalone server's tunnel) on a private testnet on 127.0.0.1: it announces the world, reports its
// status as JSON lines, follows "sync" (a rotated secret), lets the friend through to the world's listener, and stops
// cleanly when its stdin ends.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import DHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { friendKeyPair, hostKeyHex, hostKeyPair } from './keys'
import type { P2pHostStatus } from './hostTunnel'
import { runSidecar } from './sidecar'
import { openTunnel } from './tunnel'

const LOCAL = '127.0.0.1'

function sidecar(world: string, env: Record<string, string>) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const statuses: P2pHostStatus[] = []
  let buffered = ''
  stdout.setEncoding('utf8')
  stdout.on('data', (chunk: string) => {
    buffered += chunk
    for (let i; (i = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(i + 1)) statuses.push(JSON.parse(buffered.slice(0, i)).status)
  })
  stderr.resume()
  const exit = runSidecar({ argv: [world], env, stdin, stdout, stderr })
  const until = async (check: (s: P2pHostStatus) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const hit = statuses.find(check)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`no such status in ${JSON.stringify(statuses)}`)
  }
  return { stdin, statuses, exit, until }
}

test('the sidecar serves a world on a testnet, follows a new secret and stops with its stdin', async () => {
  const testnet = await createTestnet(3, { host: LOCAL })
  const world = mkdtempSync(join(tmpdir(), 'iskra-p2p-sidecar-'))
  // The world's tunnel listener stands in as a TCP server that answers after the PROXY header.
  const listener = net.createServer((sock) => {
    sock.once('data', () => sock.end('hello from the world'))
  })
  await new Promise<void>((r) => listener.listen(0, LOCAL, r))
  const friendDht = new DHT({ bootstrap: testnet.bootstrap, host: LOCAL, ephemeral: true })
  const first = Buffer.alloc(32, 7)
  const second = Buffer.alloc(32, 9)
  let run: ReturnType<typeof sidecar> | null = null
  try {
    writeFileSync(join(world, 'server.json'), JSON.stringify({ P2p: { Enabled: true }, Voice: { Enabled: false } }))
    writeFileSync(join(world, 'p2p.key'), `${first.toString('base64url')}\n`)
    writeFileSync(join(world, 'p2p.port'), `${(listener.address() as net.AddressInfo).port}\n`)
    const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')
    run = sidecar(world, { ISKRA_LOCAL_ONLY: '1', ISKRA_P2P_BOOTSTRAP: bootstrap })

    const ready = await run.until((s) => s.state === 'ready')
    assert.equal(ready.hostKey, hostKeyHex(first))
    assert.ok(ready.nat, 'the NAT picture is reported')

    const sidecarRun = run
    const reach = async (secret: Buffer) => {
      const tunnel = await openTunnel(friendDht, hostKeyPair(secret).publicKey, { web: 0 }, { keyPair: friendKeyPair(secret) })
      try {
        return await new Promise<string>((resolve, reject) => {
          const sock = net.connect(tunnel.ports.web, LOCAL, () => sock.write('hi'))
          let text = ''
          sock.on('data', (d) => (text += d))
          sock.on('close', () => resolve(text))
          sock.on('error', reject)
        })
      } finally {
        tunnel.close()
      }
    }
    assert.equal(await reach(first), 'hello from the world')

    // A rotated secret: the server writes p2p.key and says "sync"; the new host key is announced.
    writeFileSync(join(world, 'p2p.key'), `${second.toString('base64url')}\n`)
    run.stdin.write('sync\n')
    await run.until((s) => s.state === 'ready' && s.hostKey === hostKeyHex(second))
    assert.equal(await reach(second), 'hello from the world')

    sidecarRun.stdin.end()
    assert.equal(await sidecarRun.exit, 0)
    assert.equal(sidecarRun.statuses.at(-1)?.state, 'off')
  } finally {
    run?.stdin.end()
    await run?.exit
    await friendDht.destroy()
    listener.close()
    await testnet.destroy()
    rmSync(world, { recursive: true, force: true })
  }
})

test('without a testnet a LocalOnly sidecar stays off the network and says why', async () => {
  const world = mkdtempSync(join(tmpdir(), 'iskra-p2p-sidecar-'))
  try {
    writeFileSync(join(world, 'server.json'), JSON.stringify({ P2p: { Enabled: true } }))
    writeFileSync(join(world, 'p2p.key'), `${Buffer.alloc(32, 1).toString('base64url')}\n`)
    writeFileSync(join(world, 'p2p.port'), '51234\n')
    const run = sidecar(world, { ISKRA_LOCAL_ONLY: '1' })
    const status = await run.until((s) => s.state === 'unavailable')
    assert.equal(status.error, 'no-network')
    run.stdin.end()
    assert.equal(await run.exit, 0)
  } finally {
    rmSync(world, { recursive: true, force: true })
  }
})

test('a missing world folder is a usage error', async () => {
  const run = sidecar(join(tmpdir(), 'iskra-no-such-world-folder'), {})
  assert.equal(await run.exit, 2)
})
