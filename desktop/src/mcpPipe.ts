// The local channel between `Iskra --mcp` (the bridge an MCP client starts) and the running Iskra: a named pipe on
// Windows, a socket file in the app's data folder elsewhere (owner-only). Never a network port. Both sides prove they
// know a random token kept in the app's data folder (mcp.ts), so another user on the computer, or a program that took
// the pipe's name first, learns nothing and gets nothing. The running app only listens while the user has it turned on.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { checkProof, isNonce, LineReader, McpSession, newNonce, newToken, proof, type PageLink } from './mcp'

export const HANDSHAKE_MS = 5_000
export const MAX_CONNECTIONS = 4

/** Where the running app listens, for a given data folder. */
export function mcpSocketPath(userData: string, platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\iskra-mcp-${createHash('sha256').update(userData.toLowerCase()).digest('hex').slice(0, 24)}`
  return path.join(userData, 'mcp.sock')
}

export const mcpTokenPath = (userData: string) => path.join(userData, 'mcp-token')

export interface HostOptions {
  socketPath: string
  tokenFile: string
  version: string
  /** The page's tools, or null while it can't answer (locked, loading). */
  link: () => PageLink | null
  log?: (event: 'connected' | 'refused' | 'call', detail: string) => void
}

/** The running app's side. */
export class McpHost {
  #server: net.Server | null = null
  #sockets = new Set<net.Socket>()
  #token = ''
  #options: HostOptions

  constructor(options: HostOptions) {
    this.#options = options
  }

  get running(): boolean {
    return this.#server !== null
  }

  async start(): Promise<void> {
    if (this.#server) return
    this.#token = newToken()
    writeFileSync(this.#options.tokenFile, this.#token, { mode: 0o600 })
    if (process.platform !== 'win32' && existsSync(this.#options.socketPath)) rmSync(this.#options.socketPath, { force: true })
    const server = net.createServer((socket) => this.#accept(socket))
    server.maxConnections = MAX_CONNECTIONS
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ path: this.#options.socketPath, readableAll: false, writableAll: false }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') chmodSync(this.#options.socketPath, 0o600)
    server.on('error', () => undefined)
    this.#server = server
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = null
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(this.#options.tokenFile, { force: true })
    if (process.platform !== 'win32') rmSync(this.#options.socketPath, { force: true })
    this.#token = ''
  }

  #accept(socket: net.Socket): void {
    this.#sockets.add(socket)
    socket.on('close', () => this.#sockets.delete(socket))
    socket.on('error', () => undefined)
    socket.setEncoding('utf8')
    const nonce = newNonce()
    let session: McpSession | null = null
    const refuse = (why: string) => {
      this.#options.log?.('refused', why)
      socket.destroy()
    }
    const timer = setTimeout(() => refuse('timeout'), HANDSHAKE_MS)
    const send = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\n`)
    }
    const reader = new LineReader((line) => {
      if (session) return void session.handle(line)
      let hello: { proof?: unknown; nonce?: unknown }
      try {
        hello = JSON.parse(line) as typeof hello
      } catch {
        return refuse('auth')
      }
      if (!this.#token || !checkProof(this.#token, 'client', nonce, hello.proof) || !isNonce(hello.nonce)) return refuse('auth')
      clearTimeout(timer)
      send(JSON.stringify({ ok: true, proof: proof(this.#token, 'server', hello.nonce) }))
      session = new McpSession(this.#proxy(), send, this.#options.version, (name, outcome) => this.#options.log?.('call', `${name} ${outcome}`))
      this.#options.log?.('connected', '')
    }, () => refuse('too-long'))
    socket.on('data', (chunk) => reader.push(chunk))
    send(JSON.stringify({ iskra: 'mcp-1', nonce }))
  }

  /** The page as it is at each call (it may be locked or reloading in between). */
  #proxy(): PageLink {
    const off = { error: 'off' } as const
    return {
      list: () => this.#options.link()?.list() ?? Promise.resolve(off),
      call: (name, args) => this.#options.link()?.call(name, args) ?? Promise.resolve(off),
    }
  }
}

export interface BridgeOptions {
  socketPath: string
  tokenFile: string
  version: string
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  connect?: (socketPath: string) => net.Socket
  /** Diagnostics for the MCP client's log (stderr): never tokens or tool content. */
  note?: (text: string) => void
}

/** Connects and proves itself; resolves with the socket, or null (off, not running, or not the real Iskra). */
export function openChannel(options: Pick<BridgeOptions, 'socketPath' | 'tokenFile' | 'connect'>): Promise<{ socket: net.Socket; rest: LineReader | null } | { error: string }> {
  let token: string
  try {
    token = readFileSync(options.tokenFile, 'utf8').trim()
  } catch {
    return Promise.resolve({ error: 'off' })
  }
  if (!/^[0-9a-f]{64}$/.test(token)) return Promise.resolve({ error: 'off' })
  return new Promise((resolve) => {
    const socket = (options.connect ?? ((p) => net.connect(p)))(options.socketPath)
    const nonce = newNonce()
    let stage: 'hello' | 'ok' | 'done' = 'hello'
    const fail = (error: string) => {
      if (stage === 'done') return
      stage = 'done'
      clearTimeout(timer)
      socket.destroy()
      resolve({ error })
    }
    const timer = setTimeout(() => fail('timeout'), HANDSHAKE_MS)
    socket.setEncoding('utf8')
    socket.on('error', () => fail('socket'))
    socket.on('close', () => fail('socket'))
    const reader = new LineReader((line) => {
      if (stage === 'done') return
      let message: { iskra?: unknown; nonce?: unknown; ok?: unknown; proof?: unknown }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        return fail('auth')
      }
      if (stage === 'hello') {
        if (message.iskra !== 'mcp-1' || !isNonce(message.nonce)) return fail('auth')
        stage = 'ok'
        socket.write(`${JSON.stringify({ proof: proof(token, 'client', message.nonce), nonce })}\n`)
        return
      }
      if (message.ok !== true || !checkProof(token, 'server', nonce, message.proof)) return fail('auth')
      stage = 'done'
      clearTimeout(timer)
      socket.removeAllListeners('data')
      socket.removeAllListeners('close')
      socket.removeAllListeners('error')
      socket.on('error', () => undefined)
      resolve({ socket, rest: null })
    }, () => fail('too-long'))
    socket.on('data', (chunk) => reader.push(chunk))
  })
}

/** `Iskra --mcp`: relays the MCP client's stdio to the running app; answers by itself (no tools) when it can't. */
export async function runBridge(options: BridgeOptions): Promise<void> {
  const channel = await openChannel(options)
  const write = (line: string) => void options.output.write(`${line}\n`)
  if ('error' in channel) {
    options.note?.(`Iskra MCP: not connected (${channel.error}). Open Iskra and turn on "Allow local MCP clients" in My settings → Assistant.`)
    const session = new McpSession(null, write, options.version)
    const reader = new LineReader((line) => void session.handle(line), () => process.exit(1))
    options.input.on('data', (chunk: Buffer) => reader.push(chunk))
    await new Promise<void>((resolve) => options.input.on('end', () => resolve()))
    return
  }
  const { socket } = channel
  const toApp = new LineReader((line) => void socket.write(`${line}\n`), () => socket.destroy())
  const fromApp = new LineReader(write, () => socket.destroy())
  options.input.on('data', (chunk: Buffer) => toApp.push(chunk))
  socket.on('data', (chunk) => fromApp.push(chunk))
  await new Promise<void>((resolve) => {
    options.input.on('end', () => {
      socket.end()
      resolve()
    })
    socket.on('close', () => resolve())
  })
}
