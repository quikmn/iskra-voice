// Ports for the servers the interop tests start. Never the OS's ephemeral ports (Linux 32768+, Windows 49152+): a port
// found free there (listen on 0, then close) can be taken by any outgoing connection, or by another test file doing the
// same, before the server binds it, and the server or its LiveKit then doesn't start. Each vitest worker gets its own
// range below them instead (e2e/helpers.ts uses 20000 and up), so two files running at once never pick the same port.
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'

export const RANGE = 600
const pool = Math.max(0, (Number(process.env.VITEST_POOL_ID) || 1) - 1) % 16
export const rangeStart = 10000 + pool * RANGE

// The ports fetch (Node's and every browser's) refuses to connect to, whatever listens there: "bad port", the fetch
// standard's port blocking list. 10080 is in the first worker's range: a server given it started fine and every
// fetch to it failed, which read as "the server did not start" (music.test.ts on CI, 2026-11-16).
export const FETCH_BLOCKED = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])
/** Whether fetch will connect to this port at all. */
export const fetchable = (port: number): boolean => !FETCH_BLOCKED.has(port)
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
    if (handedOut.has(port) || !fetchable(port) || !(await free(port))) continue
    handedOut.add(port)
    return port
  }
  throw new Error('no free port')
}

/** A TCP port for a server (free on `host`, all addresses by default). */
export const freePort = (host?: string): Promise<number> => pick((port) => tcpFree(port, host))

/**
 * A UDP port for LiveKit's media (RtcUdpPort); the one after it stays free here too (p2p.test.ts puts TURN there).
 * Never the last port of the range: the one after that is the next worker's.
 */
export async function freeUdpPort(): Promise<number> {
  const port = await pick(async (p) => p + 1 < rangeStart + RANGE && !handedOut.has(p + 1) && (await udpFree(p)) && (await udpFree(p + 1)))
  handedOut.add(port + 1)
  return port
}
