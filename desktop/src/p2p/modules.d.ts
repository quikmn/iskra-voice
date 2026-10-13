// The HyperDHT stack ships no TypeScript types; this is the small surface the tunnel uses (hyperdht 6.34).
declare module 'hyperdht' {
  import type { EventEmitter } from 'node:events'
  import type { Duplex } from 'node:stream'

  export interface KeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }

  export interface Address {
    host: string
    port: number
  }

  /** An encrypted (Noise) stream over UDX. Reliable bytes as a stream; `send`/`trySend` carry unreliable datagrams. */
  export interface NoiseStream extends Duplex {
    readonly remotePublicKey: Buffer
    readonly publicKey: Buffer
    /** The UDX stream once connected; its remote address is the peer's (or the relay's) UDP address. */
    readonly rawStream: { remoteHost?: string; remotePort?: number } | null
    readonly destroyed: boolean
    trySend(buffer: Buffer): void
    send(buffer: Buffer): Promise<void>
    on(event: 'open', listener: () => void): this
    on(event: 'message', listener: (message: Buffer) => void): this
    on(event: 'data', listener: (chunk: Buffer) => void): this
    on(event: 'close', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
    once(event: 'open', listener: () => void): this
    once(event: 'data', listener: (chunk: Buffer) => void): this
    once(event: 'close', listener: () => void): this
    once(event: 'error', listener: (error: Error) => void): this
    once(event: string, listener: (...args: unknown[]) => void): this
  }

  export interface ServerOptions {
    /** Return true to refuse the peer before any data flows. */
    firewall?: (remotePublicKey: Buffer, payload: unknown, clientAddress: Address) => boolean | Promise<boolean>
    relayThrough?: Buffer | null
    holepunch?: boolean
    shareLocalAddress?: boolean
  }

  export interface Server extends EventEmitter {
    readonly publicKey: Buffer
    listen(keyPair?: KeyPair): Promise<void>
    close(): Promise<void>
    address(): (Address & { publicKey: Buffer }) | null
  }

  export interface ConnectOptions {
    keyPair?: KeyPair
    relayThrough?: Buffer | null
    holepunch?: boolean | (() => boolean)
  }

  export interface DHTOptions {
    bootstrap?: (Address | string)[]
    host?: string
    port?: number
    ephemeral?: boolean
    quickFirewall?: boolean
    firewalled?: boolean
    keyPair?: KeyPair
  }

  export default class DHT extends EventEmitter {
    constructor(opts?: DHTOptions)
    static keyPair(seed?: Buffer): KeyPair
    /** Behind a NAT or firewall (not reachable unsolicited). */
    readonly firewalled: boolean
    /** The NAT picks a new port per destination ("hard"/symmetric NAT). */
    readonly randomized: boolean
    readonly destroyed: boolean
    readonly bootstrapNodes: Address[]
    /** Our address as the DHT sees it (null while firewalled or unknown). */
    remoteAddress(): Address | null
    address(): Address | null
    fullyBootstrapped(): Promise<void>
    connect(remotePublicKey: Buffer, opts?: ConnectOptions): NoiseStream
    createServer(opts?: ServerOptions, onconnection?: (stream: NoiseStream) => void): Server
    destroy(opts?: { force?: boolean }): Promise<void>
  }
}

declare module 'hyperdht/testnet.js' {
  import type DHT from 'hyperdht'
  import type { Address, DHTOptions } from 'hyperdht'

  export interface Testnet {
    readonly bootstrap: Address[]
    readonly nodes: DHT[]
    createNode(opts?: DHTOptions): DHT
    destroy(): Promise<void>
  }

  export default function createTestnet(size?: number, opts?: { host?: string; port?: number; bootstrap?: Address[] }): Promise<Testnet>
}

declare module 'sodium-universal' {
  export const crypto_generichash_BYTES: number
  export function crypto_generichash(output: Uint8Array, input: Uint8Array, key?: Uint8Array): void
  export function randombytes_buf(buffer: Uint8Array): void
}
