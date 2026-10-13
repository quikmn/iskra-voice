// The host side for servers hosted by this app: while a world has P2p on, announce it and forward friends to it.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { hostKeyHex, hostKeyPair, onlyFriends, parseSecret } from './keys'
import { P2pNode, P2pUnavailableError, type NatInfo } from './node'
import { serveTunnel, type HostTunnel } from './tunnel'

/** What the app shows in Server settings → Internet access for a server it hosts. */
export interface P2pHostStatus {
  state: 'off' | 'unavailable' | 'starting' | 'ready' | 'failed'
  /** The host's DHT public key (hex), what friends look up. */
  hostKey: string | null
  nat: NatInfo | null
  /** Tunnel connections open right now. */
  connections: number
  error?: string
}

/** What a world folder says about p2p: the server writes p2p.key when it's on and p2p.port once it listens. */
export interface WorldP2p {
  enabled: boolean
  secret: Buffer | null
  tunnelPort: number | null
  turnPort: number | null
}

export function readWorldP2p(folder: string): WorldP2p {
  const read = (name: string) => {
    const file = path.join(folder, name)
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
  }
  let settings: { P2p?: { Enabled?: boolean }; Voice?: { Enabled?: boolean; RtcUdpPort?: number; TurnUdpPort?: number } } = {}
  try {
    settings = JSON.parse(read('server.json') ?? '{}')
  } catch {
    /* unreadable: treated as off */
  }
  const port = Number(read('p2p.port'))
  const voice = settings.Voice ?? {}
  const turn = voice.Enabled === false ? null : voice.TurnUdpPort && voice.TurnUdpPort > 0 ? voice.TurnUdpPort : (voice.RtcUdpPort ?? 7882) + 1
  return {
    enabled: settings.P2p?.Enabled === true,
    secret: parseSecret(read('p2p.key')),
    tunnelPort: Number.isInteger(port) && port > 0 ? port : null,
    turnPort: turn,
  }
}

interface Running {
  key: string
  tunnel: HostTunnel | null
  status: P2pHostStatus
  stopped: boolean
}

export class HostTunnels {
  private readonly running = new Map<string, Running>()

  constructor(private readonly node: P2pNode, private readonly onChange: (id: string, status: P2pHostStatus) => void = () => undefined) {}

  status(id: string): P2pHostStatus {
    return this.running.get(id)?.status ?? { state: 'off', hostKey: null, nat: null, connections: 0 }
  }

  private update(id: string, run: Running, patch: Partial<P2pHostStatus>): void {
    if (run.stopped) return
    run.status = { ...run.status, ...patch, connections: run.tunnel?.stats.open ?? 0 }
    this.onChange(id, run.status)
  }

  /** Brings the tunnel for a world in line with its folder: on, off, or a new secret or port. */
  async sync(id: string, folder: string): Promise<P2pHostStatus> {
    const world = readWorldP2p(folder)
    if (!world.enabled || !world.secret || !world.tunnelPort) {
      await this.stop(id)
      return this.status(id)
    }
    const key = `${world.secret.toString('hex')}:${world.tunnelPort}:${world.turnPort}`
    const current = this.running.get(id)
    if (current && current.key === key) return current.status
    await this.stop(id)
    const run: Running = { key, tunnel: null, status: { state: 'starting', hostKey: hostKeyHex(world.secret), nat: null, connections: 0 }, stopped: false }
    this.running.set(id, run)
    this.onChange(id, run.status)
    try {
      const dht = await this.node.get()
      if (run.stopped) return this.status(id)
      run.tunnel = await serveTunnel(dht, hostKeyPair(world.secret), { web: world.tunnelPort, ...(world.turnPort ? { turn: world.turnPort } : {}) }, { allow: onlyFriends(world.secret) })
      if (run.stopped) {
        await run.tunnel.close()
        return this.status(id)
      }
      this.update(id, run, { state: 'ready', nat: this.node.nat() })
      // The NAT picture can change (a new network): keep it fresh now and then.
      const refresh = setInterval(() => this.update(id, run, { nat: this.node.nat() }), 15_000)
      refresh.unref()
      run.tunnel.close = ((close) => async () => {
        clearInterval(refresh)
        await close()
      })(run.tunnel.close.bind(run.tunnel))
    } catch (e) {
      if (e instanceof P2pUnavailableError) this.update(id, run, { state: 'unavailable', error: e.reason })
      else this.update(id, run, { state: 'failed', error: (e as Error).message })
    }
    return this.status(id)
  }

  /** Each running tunnel's status and counters (shown by the desktop e2e test when voice fails). */
  debug(): Record<string, { status: P2pHostStatus; stats: HostTunnel['stats'] | null }> {
    return Object.fromEntries([...this.running].map(([id, run]) => [id, { status: run.status, stats: run.tunnel?.stats ?? null }]))
  }

  async stop(id: string): Promise<void> {
    const run = this.running.get(id)
    if (!run) return
    this.running.delete(id)
    run.stopped = true
    await run.tunnel?.close().catch(() => undefined)
    this.onChange(id, this.status(id))
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)))
  }
}
