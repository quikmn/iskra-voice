// Ports for the servers the interop tests start. Never the OS's ephemeral ports (Linux 32768+, Windows 49152+): a port
// found free there (listen on 0, then close) can be taken by any outgoing connection, or by another test file doing the
// same, before the server binds it, and the server or its LiveKit then doesn't start. Each vitest worker gets its own
// range below them instead (e2e/helpers.ts uses 20000 and up), so two files running at once never pick the same port.
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'

const RANGE = 600
const pool = Math.max(0, (Number(process.env.VITEST_POOL_ID) || 1) - 1) % 16
const rangeStart = 10000 + pool * RANGE
let next = Math.floor(Math.random() * RANGE)
/** Handed out in this worker, so a port isn't reused while a server from an earlier test may still hold it. */
const handedOut = new Set<number>()

const tcpFree = (port: number, host?: string) =>
  new Promise<boolean>((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, host, () => probe.close(() => done(true)))
  })

const udpFree = (port: number) =>
  new Promise<boolean>((done) => {
    const probe = createSocket('udp4')
    probe.once('error', () => {
      probe.close()
      done(false)
    })
    probe.bind(port, () => probe.close(() => done(true)))
  })

async function pick(free: (port: number) => Promise<boolean>): Promise<number> {
  for (let i = 0; i < RANGE; i++) {
    const port = rangeStart + (next++ % RANGE)
    if (handedOut.has(port) || !(await free(port))) continue
    handedOut.add(port)
    return port
  }
  throw new Error('no free port')
}

/** A TCP port for a server (free on `host`, all addresses by default). */
export const freePort = (host?: string): Promise<number> => pick((port) => tcpFree(port, host))

/** A UDP port for LiveKit's media (RtcUdpPort); the one after it stays free here too (p2p.test.ts puts TURN there). */
export async function freeUdpPort(): Promise<number> {
  const port = await pick(async (p) => !handedOut.has(p + 1) && (await udpFree(p)) && (await udpFree(p + 1)))
  handedOut.add(port + 1)
  return port
}
