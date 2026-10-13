// Which DHT the app joins and where its UDP socket binds. The public HyperDHT only from a packaged app: development
// builds and tests bind 127.0.0.1 and need a private testnet (ISKRA_P2P_BOOTSTRAP), so no dev or test run ever
// contacts the public network or makes Windows ask about the firewall.

export interface P2pNetwork {
  /** The address the DHT's UDP socket binds. */
  bind: string
  /** Its port (0 = any). HyperDHT's usual 49737 on the real network, so NAT mappings stay the same. */
  port: number
  /** Bootstrap nodes, or null for HyperDHT's own public list. */
  bootstrap: { host: string; port: number }[] | null
}

/** Why p2p is off in this run: a loopback-only run with no testnet to join. */
export type P2pUnavailable = { unavailable: 'no-network' }

type Env = Record<string, string | undefined>

/** "host:port,host:port", or "public" for HyperDHT's list. Anything malformed is ignored. */
export function parseBootstrap(text: string | undefined): { host: string; port: number }[] | 'public' | null {
  if (!text) return null
  if (text.trim() === 'public') return 'public'
  const nodes: { host: string; port: number }[] = []
  for (const entry of text.split(',')) {
    const match = /^\s*([0-9.]+|\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})\s*$/.exec(entry)
    if (!match) continue
    const port = Number(match[2])
    if (port > 0 && port < 65536) nodes.push({ host: match[1].replace(/^\[|\]$/g, ''), port })
  }
  return nodes.length ? nodes : null
}

export function p2pNetwork(env: Env, packaged: boolean): P2pNetwork | P2pUnavailable {
  const loopbackOnly = env.ISKRA_LOCAL_ONLY === '1' || !packaged
  const bind = env.ISKRA_P2P_BIND || (loopbackOnly ? '127.0.0.1' : '0.0.0.0')
  const loopback = bind === '127.0.0.1' || bind === 'localhost'
  const bootstrap = parseBootstrap(env.ISKRA_P2P_BOOTSTRAP)
  // Bound to loopback, only a testnet named by the environment makes sense; the public list would be unreachable
  // anyway and must never be tried from a dev or test run.
  if (loopback && (bootstrap === null || bootstrap === 'public')) return { unavailable: 'no-network' }
  const port = Number(env.ISKRA_P2P_PORT)
  return {
    bind,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : loopback ? 0 : 49737,
    bootstrap: bootstrap === 'public' ? null : bootstrap,
  }
}

export const isUnavailable = (n: P2pNetwork | P2pUnavailable): n is P2pUnavailable => 'unavailable' in n
