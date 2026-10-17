// The peer-to-peer tunnel: Iskra's protocol carried inside HyperDHT connections (Noise-encrypted UDX over UDP,
// hole-punched, or through a blind relay when that fails). PROTOCOL.md, "Connecting without port forwarding".
//
// Host (serveTunnel): announces the host key pair on the DHT, accepts only the friend key pair (proof of the invite
//   secret), and forwards each connection to ONE of a fixed set of local services (never an open proxy): the
//   server's tunnel listener on 127.0.0.1 (with a PROXY v2 header naming the friend) and LiveKit's TURN port (UDP).
// Friend (openTunnel): listens on 127.0.0.1 only; each local TCP connection rides its own DHT connection; TURN
//   datagrams go as unreliable encrypted UDX messages, so media never waits behind lost packets.
//
// Wire format inside the encrypted stream: the first byte picks the service. The TURN service carries no stream
// bytes; every datagram is one message: flow id (u16 BE) + payload.
import type DHT from 'hyperdht'
import type { KeyPair, NoiseStream } from 'hyperdht'
import dgram from 'node:dgram'
import net from 'node:net'
import { proxyV2Header } from './proxy'
import { errorWhy, FriendNotes, HostNotes, isLocalAddress, nodeNat, noLog, punchCounters, routeOf, TURN_SAMPLE_MS, type TunnelLogger, type TunnelLogValue } from './tunnelLog'

export const SERVICE = { web: 1, turn: 2 } as const
export type Service = keyof typeof SERVICE
export const LOCAL = '127.0.0.1'

export interface HostServices {
  /** The server's tunnel listener (p2p.port in the world folder). */
  web: number
  /** LiveKit's embedded TURN server (UDP), when voice is on. */
  turn?: number
}

export interface HostTunnelOptions {
  /** Which DHT keys may connect (onlyFriends(secret)). */
  allow: (remotePublicKey: Buffer) => boolean
  /** Its log lines (tunnelLog.ts): types, counts and durations only. */
  log?: TunnelLogger
  /** Test knobs: carry everything through this blind relay, and never punch or use the LAN shortcut. */
  relayThrough?: Buffer | null
  forceRelay?: boolean
}

export interface TunnelStats {
  /** Connections right now, and in total. */
  open: number
  total: number
  /** TURN datagrams carried each way. */
  datagramsIn: number
  datagramsOut: number
  /** Voice flows (TURN senders) carried right now. */
  flows: number
}

export interface HostTunnel {
  readonly publicKey: Buffer
  readonly stats: TunnelStats
  close(): Promise<void>
}

/** Peer address of a connection: the friend's public UDP address, or the relay's for a relayed one. */
function peerOf(stream: NoiseStream): { address: string; port: number } | null {
  const raw = stream.rawStream
  return raw?.remoteHost && raw.remotePort ? { address: raw.remoteHost, port: raw.remotePort } : null
}

function splice(stream: NoiseStream, sock: net.Socket): void {
  stream.pipe(sock)
  sock.pipe(stream)
  const end = () => {
    sock.destroy()
    stream.destroy()
  }
  stream.on('close', end)
  sock.on('close', end)
  stream.on('error', end)
  sock.on('error', end)
}

export async function serveTunnel(dht: DHT, keyPair: KeyPair, services: HostServices, opts: HostTunnelOptions): Promise<HostTunnel> {
  const notes = new HostNotes(opts.log ?? noLog)
  const stats: TunnelStats = { open: 0, total: 0, datagramsIn: 0, datagramsOut: 0, flows: 0 }
  const server = dht.createServer(
    {
      firewall: (remotePublicKey) => !opts.allow(remotePublicKey),
      relayThrough: opts.relayThrough ?? null,
      ...(opts.forceRelay ? { shareLocalAddress: false, holepunch: false } : {}),
    },
    (stream) => {
      stats.open++
      stats.total++
      notes.peers(stats.open, stats.total)
      stream.on('error', () => undefined)
      stream.once('close', () => {
        stats.open--
        notes.peers(stats.open, stats.total)
      })
      stream.once('data', (first: Buffer) => {
        const rest = first.subarray(1)
        switch (first[0]) {
          case SERVICE.web:
            forwardTcp(stream, services.web, rest)
            return
          case SERVICE.turn:
            if (services.turn) forwardDatagrams(stream, services.turn, stats)
            else stream.destroy()
            return
          default:
            stream.destroy() // not a service this host offers
        }
      })
    },
  )
  const listening = performance.now()
  await server.listen(keyPair)
  notes.announced(performance.now() - listening, nodeNat(dht))
  // Now and then: a new NAT type (another network), the friend count, and voice carried since the last line.
  let turnAt = Date.now()
  const timer = setInterval(() => {
    notes.natSeen(nodeNat(dht))
    notes.peers(stats.open, stats.total)
    if (Date.now() - turnAt >= TURN_SAMPLE_MS) {
      turnAt = Date.now()
      notes.turn(stats.flows, stats.datagramsIn, stats.datagramsOut)
    }
  }, 15_000)
  timer.unref?.()
  return {
    publicKey: keyPair.publicKey,
    stats,
    close: () => {
      clearInterval(timer)
      return server.close()
    },
  }
}

/** The web service: one local TCP connection to the server's tunnel listener, introduced with a PROXY header. */
function forwardTcp(stream: NoiseStream, port: number, rest: Buffer): void {
  stream.pause()
  const sock = net.connect({ host: LOCAL, port }, () => {
    sock.write(proxyV2Header(peerOf(stream), { address: LOCAL, port }))
    if (rest.length) sock.write(rest)
    splice(stream, sock)
    stream.resume()
  })
  sock.on('error', () => stream.destroy())
}

/** The TURN service: one local UDP socket per friend flow, so LiveKit sees a distinct 5-tuple per flow. */
function forwardDatagrams(stream: NoiseStream, port: number, stats: TunnelStats): void {
  const flows = new Map<number, dgram.Socket>()
  stream.on('message', (message: Buffer) => {
    if (message.length < 2) return
    stats.datagramsIn++
    const id = message.readUInt16BE(0)
    let sock = flows.get(id)
    if (!sock) {
      if (flows.size >= 64) return // one friend doesn't get to open endless sockets
      sock = dgram.createSocket('udp4')
      sock.bind(0, LOCAL)
      sock.on('error', () => undefined) // a local socket to LiveKit's TURN port: nothing worth a line
      stats.flows++
      sock.on('message', (data) => {
        const out = Buffer.allocUnsafe(data.length + 2)
        out.writeUInt16BE(id, 0)
        data.copy(out, 2)
        stats.datagramsOut++
        stream.trySend(out)
      })
      flows.set(id, sock)
    }
    sock.send(message.subarray(2), port, LOCAL)
  })
  stream.on('data', () => undefined) // keep the reliable side flowing (keep-alives)
  stream.on('close', () => {
    stats.flows -= flows.size
    flows.forEach((s) => s.close())
  })
}

export interface FriendPorts {
  /** Local ports on 127.0.0.1 to listen on (0 = any). */
  web: number
  turn?: number
}

export interface FriendTunnelOptions {
  keyPair: KeyPair
  /** Its log lines (tunnelLog.ts), each with `logFields` first (the server's srv= id). */
  log?: TunnelLogger
  logFields?: [string, TunnelLogValue][]
  relayThrough?: Buffer | null
  /** Test knob: never punch (relay only). */
  forceRelay?: boolean
}

export interface FriendTunnel {
  /** The local ports to give the app: http://127.0.0.1:<web>, turn:127.0.0.1:<turn>. */
  readonly ports: { web: number; turn: number | null }
  /** Milliseconds each DHT connection took to open, newest last (for the status line). */
  readonly timings: number[]
  readonly stats: TunnelStats
  close(): void
}

export async function openTunnel(dht: DHT, hostPublicKey: Buffer, ports: FriendPorts, opts: FriendTunnelOptions): Promise<FriendTunnel> {
  const notes = new FriendNotes(opts.log ?? noLog, () => opts.logFields ?? [])
  const timings: number[] = []
  const stats: TunnelStats = { open: 0, total: 0, datagramsIn: 0, datagramsOut: 0, flows: 0 }
  const connect = (service: number): NoiseStream => {
    stats.total++
    stats.open++
    const started = performance.now()
    const punches = punchCounters(dht)
    const stream = dht.connect(hostPublicKey, {
      keyPair: opts.keyPair,
      relayThrough: opts.relayThrough ?? null,
      ...(opts.forceRelay ? { holepunch: () => false } : {}),
    })
    let opened = false
    stream.once('open', () => {
      opened = true
      const ms = performance.now() - started
      timings.push(ms)
      if (timings.length > 20) timings.shift()
      // How it got through: punch counters and whether the peer is on this machine or LAN (the address isn't kept).
      const path = routeOf(punches, punchCounters(dht), { relayed: !!opts.relayThrough || !!opts.forceRelay, local: isLocalAddress(stream.rawStream?.remoteHost) })
      notes.connected(path, ms, nodeNat(dht))
    })
    stream.once('error', (e: unknown) => {
      if (!opened) notes.failed(errorWhy(e), performance.now() - started, nodeNat(dht))
    })
    stream.once('close', () => stats.open--)
    stream.write(Buffer.from([service]))
    return stream
  }

  const web = net.createServer((sock) => {
    const stream = connect(SERVICE.web)
    stream.on('error', () => sock.destroy())
    splice(stream, sock)
  })
  await new Promise<void>((resolve, reject) => {
    web.once('error', reject)
    web.listen(ports.web, LOCAL, () => resolve())
  })
  const webPort = (web.address() as net.AddressInfo).port
  let turn: { port: number; close(): void } | null = null
  if (ports.turn !== undefined) {
    try {
      turn = await datagramFriend(connect, ports.turn, stats, notes)
    } catch (e) {
      web.close()
      throw e
    }
  }
  return {
    ports: { web: webPort, turn: turn?.port ?? null },
    timings,
    stats,
    close: () => {
      web.close()
      turn?.close()
    },
  }
}

/**
 * The friend's TURN socket: LiveKit (in the renderer) sends TURN to 127.0.0.1:<port>; every sender address becomes a
 * flow over ONE long-lived DHT connection, remade if it drops.
 */
async function datagramFriend(connect: (service: number) => NoiseStream, port: number, stats: TunnelStats, notes: FriendNotes) {
  const sock = dgram.createSocket('udp4')
  await new Promise<void>((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(port, LOCAL, () => resolve())
  })
  const flows = new Map<string, number>() // "addr:port" → id
  const back = new Map<number, { address: string; port: number }>()
  let stream: NoiseStream | null = null
  let open = false
  let closed = false
  const ensure = (): NoiseStream => {
    if (stream && !stream.destroyed) return stream
    open = false
    const next = (stream = connect(SERVICE.turn))
    let openedAt = 0
    next.once('open', () => {
      open = true
      openedAt = performance.now()
    })
    next.on('error', () => undefined)
    next.on('data', () => undefined)
    next.on('close', () => {
      if (stream === next) stream = null
      // Voice through the tunnel lost its link (it's remade with the next packet); a link that never opened is a failed connect.
      if (!closed && openedAt) notes.turnClosed(performance.now() - openedAt)
    })
    next.on('message', (message: Buffer) => {
      if (message.length < 2) return
      stats.datagramsIn++
      const to = back.get(message.readUInt16BE(0))
      if (to) sock.send(message.subarray(2), to.port, to.address)
    })
    return next
  }
  sock.on('message', (data, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`
    let id = flows.get(key)
    if (id === undefined) {
      if (flows.size >= 64) return
      id = flows.size + 1
      flows.set(key, id)
      stats.flows = flows.size
      back.set(id, { address: rinfo.address, port: rinfo.port })
    }
    const s = ensure()
    const out = Buffer.allocUnsafe(data.length + 2)
    out.writeUInt16BE(id, 0)
    data.copy(out, 2)
    stats.datagramsOut++
    if (open) s.trySend(out)
    else s.once('open', () => s.trySend(out))
  })
  ensure()
  return {
    port: (sock.address() as net.AddressInfo).port,
    close: () => {
      closed = true
      sock.close()
      stream?.destroy()
    },
  }
}
