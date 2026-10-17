// The friend side for servers this app joins: a local address on 127.0.0.1 that leads, through the DHT, to a server
// behind a shared connection. One per server key, with the same local ports for as long as the app runs.
import { friendKeyPair, hostKeyPair, parseSecret } from './keys'
import type { P2pNode } from './node'
import { openTunnel, type FriendTunnel } from './tunnel'
import { noLog, serverLogId, type TunnelLogger } from './tunnelLog'

export interface TunnelEndpoint {
  /** Where the app talks to the server instead of its direct address. */
  url: string
  /** LiveKit's TURN, for voice: turn:127.0.0.1:<turnPort>. */
  turnPort: number
}

interface Open {
  secret: string
  tunnel: FriendTunnel
  endpoint: TunnelEndpoint
}

export class ClientTunnels {
  private readonly open = new Map<string, Open>()
  private readonly opening = new Map<string, Promise<TunnelEndpoint>>()
  /** Ports a server key got before, so its local address stays the same within this run. */
  private readonly ports = new Map<string, { web: number; turn: number }>()

  constructor(private readonly node: P2pNode, private readonly log: TunnelLogger = noLog) {}

  /** Opens (or reuses) the tunnel to the server whose invite carried `secret` (b64u). */
  get(serverKey: string, secret: string): Promise<TunnelEndpoint> {
    const existing = this.open.get(serverKey)
    if (existing && existing.secret === secret) return Promise.resolve(existing.endpoint)
    const pending = this.opening.get(serverKey)
    if (pending) return pending
    const task = this.start(serverKey, secret).finally(() => this.opening.delete(serverKey))
    this.opening.set(serverKey, task)
    return task
  }

  private async start(serverKey: string, secretText: string): Promise<TunnelEndpoint> {
    await this.close(serverKey)
    const secret = parseSecret(secretText)
    if (!secret) throw new Error('Not a p2p secret.')
    const dht = await this.node.get()
    const ports = this.ports.get(serverKey) ?? { web: 0, turn: 0 }
    // Lines name the server as the app and the server do (srv=), never by its key or address.
    const options = { keyPair: friendKeyPair(secret), log: this.log, logFields: [['srv', serverLogId(serverKey)]] as [string, string | null][] }
    let tunnel: FriendTunnel
    try {
      tunnel = await openTunnel(dht, hostKeyPair(secret).publicKey, ports, options)
    } catch {
      // The remembered ports were taken meanwhile: any free ones.
      tunnel = await openTunnel(dht, hostKeyPair(secret).publicKey, { web: 0, turn: 0 }, options)
    }
    this.ports.set(serverKey, { web: tunnel.ports.web, turn: tunnel.ports.turn ?? 0 })
    const endpoint = { url: `http://127.0.0.1:${tunnel.ports.web}`, turnPort: tunnel.ports.turn ?? 0 }
    this.open.set(serverKey, { secret: secretText, tunnel, endpoint })
    return endpoint
  }

  /** Each open tunnel's ports and counters (shown by the desktop e2e test when voice fails). */
  debug(): Record<string, { endpoint: TunnelEndpoint; stats: FriendTunnel['stats']; timings: number[] }> {
    return Object.fromEntries([...this.open].map(([key, o]) => [key.slice(0, 8), { endpoint: o.endpoint, stats: o.tunnel.stats, timings: o.tunnel.timings }]))
  }

  async close(serverKey: string): Promise<void> {
    const open = this.open.get(serverKey)
    if (!open) return
    this.open.delete(serverKey)
    open.tunnel.close()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((key) => this.close(key)))
  }
}
