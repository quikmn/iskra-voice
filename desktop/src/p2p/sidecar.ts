// iskra-p2p: the peer-to-peer tunnel for the standalone server (no desktop app), the same host side the desktop app
// runs for the worlds it hosts (HostTunnels). iskra-server starts it while P2p is on and supervises it like LiveKit
// (server/src/Iskra.Server/Hosting/P2pSidecar.cs); release builds make it one file with Node's single executable
// applications (desktop/scripts/build-sidecar.mjs).
//
//   iskra-p2p <world folder>
//
// It reads the world's p2p.key, p2p.port and server.json itself (no secret on the command line or in the
// environment). The DHT: ISKRA_P2P_BOOTSTRAP / ISKRA_P2P_PORT / ISKRA_P2P_BIND as in network.ts; with
// ISKRA_LOCAL_ONLY=1 it binds 127.0.0.1 and only joins a testnet named by ISKRA_P2P_BOOTSTRAP.
// stdin: a line "sync" re-reads the world (a new secret); the end of stdin stops it cleanly (the server closed it, or
// went away). stdout: one JSON line `{"status":P2pHostStatus}` whenever the status changes, and `{"log":TunnelLogEvent}`
// for the tunnel's own log lines (types, counts and durations: the server checks them again and writes them as `p2p`).
// Anything else (usage, a crash) goes to stderr.
import { existsSync, statSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { HostTunnels, type P2pHostStatus } from './hostTunnel'
import { p2pNetwork } from './network'
import { P2pNode } from './node'

export const SIDECAR_VERSION = '1'
const WORLD = 'world'

export interface SidecarIo {
  argv: string[]
  env: Record<string, string | undefined>
  stdin: Readable
  stdout: Writable
  stderr: Writable
}

/** Runs until stdin ends (or a signal); resolves with the exit code. */
export async function runSidecar(io: SidecarIo): Promise<number> {
  const [folder] = io.argv
  const log = (...args: unknown[]): void => void io.stderr.write(`${args.map(String).join(' ')}\n`)
  if (folder === '--version') {
    io.stdout.write(`${SIDECAR_VERSION}\n`)
    return 0
  }
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) {
    log('usage: iskra-p2p <world folder>')
    return 2
  }

  // Always "packaged": this is what runs on a real server. ISKRA_LOCAL_ONLY=1 (LocalOnly worlds, tests) keeps it on
  // 127.0.0.1 and off the public network.
  const node = new P2pNode(p2pNetwork(io.env, true))
  let last = ''
  const report = (status: P2pHostStatus) => {
    const line = JSON.stringify({ status })
    if (line === last) return
    last = line
    io.stdout.write(`${line}\n`)
  }
  const tunnels = new HostTunnels(node, (_, status) => report(status), (event) => void io.stdout.write(`${JSON.stringify({ log: event })}\n`))

  let code = 0
  let finish: () => void = () => undefined
  let syncing = Promise.resolve()
  const sync = () => {
    syncing = syncing.then(async () => {
      const status = await tunnels.sync(WORLD, folder)
      report(status)
      if (status.state === 'failed') {
        // The server starts us again after a pause, with a fresh node.
        log('p2p: the tunnel failed:', status.error ?? '')
        code = 1
        finish()
      }
    }).catch((e: Error) => log('p2p: sync failed:', e.message))
    return syncing
  }

  const done = new Promise<void>((resolve) => {
    finish = resolve
    let buffered = ''
    io.stdin.setEncoding('utf8')
    io.stdin.on('data', (chunk: string) => {
      buffered = (buffered + chunk).slice(-1024) // only short commands are ever sent
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const command = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (command === 'sync') void sync()
      }
    })
    io.stdin.once('end', resolve)
    io.stdin.once('close', resolve)
    io.stdin.once('error', resolve)
  })

  await sync()
  if (!node.available) log('p2p: no network to join (LocalOnly without a testnet); waiting to be stopped')
  await done
  await syncing
  await tunnels.stopAll()
  await node.destroy()
  return code
}
