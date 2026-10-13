// One HyperDHT node for the whole app (hosted servers and the servers you join share it), made on first use.
import DHT from 'hyperdht'
import { isUnavailable, type P2pNetwork, type P2pUnavailable } from './network'

export class P2pUnavailableError extends Error {
  constructor(public readonly reason: P2pUnavailable['unavailable']) {
    super(reason === 'no-network' ? 'Peer-to-peer connections are off in this build or mode (no network to join).' : reason)
  }
}

export interface NatInfo {
  /** Behind a NAT or firewall (true for nearly every home). */
  firewalled: boolean
  /** The NAT gives each destination a new port: hard to punch; friends on such NATs too may need a relay. */
  randomized: boolean
  /** Our address as the DHT sees it, when it's known. */
  publicAddress: string | null
}

export class P2pNode {
  private node: Promise<DHT> | null = null
  private dht: DHT | null = null

  constructor(readonly config: P2pNetwork | P2pUnavailable) {}

  get available(): boolean {
    return !isUnavailable(this.config)
  }

  /** The node, bootstrapped (or bootstrapping: connections wait by themselves). Throws when p2p is unavailable here. */
  get(): Promise<DHT> {
    if (isUnavailable(this.config)) return Promise.reject(new P2pUnavailableError(this.config.unavailable))
    const { bind, port, bootstrap } = this.config
    this.node ??= (async () => {
      const dht = new DHT({ host: bind, port, ...(bootstrap ? { bootstrap } : {}) })
      this.dht = dht
      await dht.fullyBootstrapped()
      return dht
    })()
    return this.node
  }

  nat(): NatInfo | null {
    const dht = this.dht
    if (!dht || dht.destroyed) return null
    const remote = dht.remoteAddress()
    return { firewalled: dht.firewalled, randomized: dht.randomized, publicAddress: remote ? `${remote.host}:${remote.port}` : null }
  }

  async destroy(): Promise<void> {
    const node = this.node
    this.node = null
    this.dht = null
    if (!node) return
    try {
      await (await node).destroy()
    } catch {
      /* already gone */
    }
  }
}
