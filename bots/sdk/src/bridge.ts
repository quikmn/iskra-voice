// The any-language bridge: a bot (the normal SDK, signed handshake and all) that talks to another program in
// newline-delimited JSON over that program's stdin and stdout. No HTTP and no listening sockets: the program only reads
// and writes lines. The line protocol is versioned and documented in docs/bots.md ("Other languages").
//   out (to the program):  {"event":"command","ref":"r1","body":{...}}
//   in  (from the program): {"id":1,"type":"chat.send","body":{...}}  →  {"id":1,"ok":true,"body":{...}}
import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { Bot, CommandContext, CommandSpec, ComponentContext, IncomingDm, IncomingMessage, MessageContent, ModalContext } from './bot'
import type { DmFile } from '../../../client/src/core/dmFiles'
import { RequestError } from '../../../client/src/core/protocol'

/** The line protocol's version, in the `hello` event. Additions (new events, fields or requests) keep the version. */
export const BRIDGE_PROTOCOL = 1
/** A line from the program: at most this many bytes (1 MiB). Longer lines are refused whole (`too_large`). */
export const MAX_LINE_BYTES = 1024 * 1024
/** Requests from the program waiting for an answer at once; more are refused (`busy`). */
export const MAX_IN_FLIGHT = 64
/** How long a `ref` can be answered (the server's interaction tokens last as long), and how many are kept. */
export const REF_TTL_MS = 15 * 60_000
export const MAX_REFS = 1000

/** What the bridge needs of a bot (a `Bot`, or a fake in tests). */
export type BridgeBot = Pick<Bot, 'name' | 'me' | 'channels' | 'members' | 'on' | 'command' | 'removeCommand' | 'onComponent'
  | 'onModalSubmit' | 'request' | 'send' | 'sendDm' | 'upload' | 'downloadDmFile' | 'commandList'>

type Answerable =
  | { kind: 'command'; ctx: CommandContext }
  | { kind: 'component'; ctx: ComponentContext }
  | { kind: 'modal'; ctx: ModalContext }
  | { kind: 'message'; message: IncomingMessage }
  | { kind: 'dm'; dm: IncomingDm }

export interface BridgeError {
  code: string
  message: string
  key?: string
  args?: Record<string, string | number>
}

class BridgeFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const fail = (code: string, message: string) => new BridgeFailure(code, message)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Content fields a program may give for a message: the same names as the protocol's. */
function content(body: Record<string, unknown>): MessageContent {
  const out: MessageContent = {}
  if (body.text !== undefined) {
    if (typeof body.text !== 'string') throw fail('bad_request', '"text" must be a string.')
    out.text = body.text
  }
  if (body.cards !== undefined) out.cards = body.cards as MessageContent['cards']
  if (body.components !== undefined) out.components = body.components as MessageContent['components']
  if (body.attachments !== undefined) out.attachments = body.attachments as string[]
  if (body.replyTo !== undefined) out.replyTo = body.replyTo as number
  return out
}

export interface BridgeOptions {
  /** Writes one line (no newline) to the program. */
  write: (line: string) => void
  /** Where the bridge's own notes go (never the program's channel). */
  log: (line: string) => void
  /** Also forward every raw server event as `{"event":"server","type","body"}`. */
  raw?: boolean
  /** Shown in `hello`. */
  version?: string
  /** Resolves once the bot is online; requests other than `bridge.commands` wait for it. */
  started?: Promise<void>
}

export class Bridge {
  private readonly bot: BridgeBot
  private readonly options: BridgeOptions
  private readonly refs = new Map<string, { at: number; target: Answerable }>()
  private nextRef = 0
  private inFlight = 0
  /** Commands the program registered (so `bridge.commands` can replace them). */
  private registered = new Set<string>()

  constructor(bot: BridgeBot, options: BridgeOptions) {
    this.bot = bot
    this.options = options
    bot.on('ready', () => this.emit('ready', { me: bot.me, channels: bot.channels, commands: bot.commandList }))
    bot.on('status', (status) => this.emit('status', status))
    bot.on('message', (message) => this.emit('message', { message: plainMessage(message), authorName: message.authorName }, { kind: 'message', message }))
    bot.on('dm', (dm) => this.emit('dm', { id: dm.id, from: dm.from, authorName: dm.authorName, text: dm.text, sentAt: dm.sentAt, files: dm.files }, { kind: 'dm', dm }))
    bot.on('memberJoined', (member) => this.emit('memberJoined', { member }))
    bot.on('messageEdited', (message) => this.emit('messageEdited', { message }))
    bot.on('messageDeleted', (body) => this.emit('messageDeleted', body))
    bot.on('reactions', (body) => this.emit('reactions', body))
    bot.on('pollUpdated', (body) => this.emit('pollUpdated', body))
    if (options.raw) bot.on('event', (type, body) => this.emit('server', body, undefined, type))
    // Every click and form goes to the program, which knows its own customIds.
    bot.onComponent(/^/, (ctx) => {
      this.emit('component', {
        customId: ctx.customId, values: ctx.values, user: ctx.user, userName: ctx.userName, channelId: ctx.channelId,
        ...(ctx.messageId !== undefined ? { messageId: ctx.messageId } : {}), ...(ctx.responseId !== undefined ? { responseId: ctx.responseId } : {}),
        private: ctx.interaction?.private ?? false,
      }, { kind: 'component', ctx })
    })
    bot.onModalSubmit(/^/, (ctx) => {
      this.emit('modal', { customId: ctx.customId, fields: ctx.fields, user: ctx.user, userName: ctx.userName, channelId: ctx.channelId },
        { kind: 'modal', ctx })
    })
  }

  /** The first line the program gets. */
  hello(): void {
    this.write({ event: 'hello', body: { v: BRIDGE_PROTOCOL, bridge: this.options.version ?? 'iskra-bots', name: this.bot.name } })
  }

  /** Tells the program the bridge is going away (the bot couldn't start, or was removed), before it closes. */
  stopped(reason: string): void {
    this.write({ event: 'stopped', body: { reason } })
  }

  /** One line from the program. Never throws: every problem becomes an answer line (or a log line). */
  async line(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!trimmed.startsWith('{')) {
      // A stray print: pass it on as a log line rather than breaking anything.
      this.options.log(`(program) ${trimmed.slice(0, 2000)}`)
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(trimmed)
    } catch {
      this.answer(null, false, { code: 'bad_request', message: 'That line isn\'t valid JSON.' })
      return
    }
    if (!isObject(frame)) return this.answer(null, false, { code: 'bad_request', message: 'A request is a JSON object.' })
    const id = frame.id
    if (!((typeof id === 'string' && id.length >= 1 && id.length <= 64) || (typeof id === 'number' && Number.isSafeInteger(id))))
      return this.answer(null, false, { code: 'bad_request', message: '"id" must be a string (1–64 characters) or an integer.' })
    if (typeof frame.type !== 'string' || !/^[a-zA-Z][\w.-]{0,63}$/.test(frame.type))
      return this.answer(id, false, { code: 'bad_request', message: '"type" must be a request type, like "chat.send".' })
    if (frame.body !== undefined && !isObject(frame.body)) return this.answer(id, false, { code: 'bad_request', message: '"body" must be an object.' })
    if (this.inFlight >= MAX_IN_FLIGHT)
      return this.answer(id, false, { code: 'busy', message: `At most ${MAX_IN_FLIGHT} requests can wait for an answer at once.` })
    this.inFlight++
    try {
      const body = (frame.body ?? {}) as Record<string, unknown>
      if (frame.type !== 'bridge.commands' && frame.type !== 'bridge.info') await this.options.started
      this.answer(id, true, await this.handle(frame.type, body))
    } catch (e) {
      this.answer(id, false, errorOf(e))
    } finally {
      this.inFlight--
    }
  }

  /** A line that was too long: refused whole. */
  tooLong(): void {
    this.answer(null, false, { code: 'too_large', message: `A line can be at most ${MAX_LINE_BYTES} bytes.` })
  }

  private async handle(type: string, body: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case 'bridge.commands':
        return this.setCommands(body)
      case 'bridge.info':
        return { me: this.bot.me, channels: this.bot.channels, members: [...this.bot.members.values()], commands: this.bot.commandList }
      case 'bridge.reply': {
        const target = this.ref(body)
        const message = content(body)
        if (target.kind === 'message') return { message: await target.message.reply(message) }
        if (target.kind === 'dm') {
          await target.dm.reply(message)
          return { message: null }
        }
        return { message: await target.ctx.reply(message, { private: body.private === true }) }
      }
      case 'bridge.defer': {
        const target = this.ref(body)
        if (target.kind === 'message' || target.kind === 'dm') throw fail('bad_request', 'Only commands, clicks and forms can be deferred.')
        await target.ctx.defer()
        return {}
      }
      case 'bridge.update': {
        const target = this.ref(body)
        if (target.kind !== 'component') throw fail('bad_request', 'Only a click can update the message it came from.')
        await target.ctx.update(content(body))
        return {}
      }
      case 'bridge.modal': {
        const target = this.ref(body)
        if (target.kind !== 'command' && target.kind !== 'component') throw fail('bad_request', 'Only commands and clicks can show a form.')
        if (!isObject(body.modal)) throw fail('bad_request', '"modal" must be an object.')
        await target.ctx.showModal(body.modal as never)
        return {}
      }
      case 'bridge.react': {
        const target = this.ref(body)
        if (typeof body.emoji !== 'string') throw fail('bad_request', '"emoji" must be a string.')
        if (target.kind === 'message') await target.message.react(body.emoji)
        else if (target.kind === 'command') await target.ctx.react(body.emoji)
        else throw fail('bad_request', 'Only messages and commands typed as text can get a reaction.')
        return {}
      }
      case 'bridge.send': {
        if (typeof body.channelId !== 'number') throw fail('bad_request', '"channelId" must be a number.')
        return { message: await this.bot.send(body.channelId, content(body)) }
      }
      case 'bridge.dm': {
        if (typeof body.accountKey !== 'string') throw fail('bad_request', '"accountKey" must be a string.')
        await this.bot.sendDm(body.accountKey, content(body))
        return {}
      }
      case 'bridge.upload': {
        if (typeof body.name !== 'string' || typeof body.data !== 'string') throw fail('bad_request', '"name" and "data" (base64) must be strings.')
        return { file: await this.bot.upload({ name: body.name, data: new Uint8Array(Buffer.from(body.data, 'base64')) }) }
      }
      case 'bridge.dmFile': {
        if (!isObject(body.file)) throw fail('bad_request', '"file" must be a file from a dm event.')
        return { data: Buffer.from(await this.bot.downloadDmFile(body.file as unknown as DmFile)).toString('base64') }
      }
      default:
        if (type.startsWith('bridge.')) throw fail('unknown_type', `No bridge request "${type}".`)
        // Anything else is a protocol request (PROTOCOL.md), sent as the bot.
        return this.bot.request(type as never, body as never)
    }
  }

  private setCommands(body: Record<string, unknown>): unknown {
    if (!Array.isArray(body.commands)) throw fail('bad_request', '"commands" must be a list.')
    const specs = body.commands as Omit<CommandSpec, 'handler'>[]
    // Check them all before changing anything (the SDK throws on a bad name).
    for (const spec of specs) {
      if (!isObject(spec) || typeof spec.name !== 'string' || typeof spec.description !== 'string')
        throw fail('bad_request', 'Each command needs a "name" and a "description".')
      if (spec.name.toLowerCase() === 'help') throw fail('bad_request', '/help is built in.')
      if (!/^[a-z0-9][\w-]{0,31}$/.test(spec.name.toLowerCase()))
        throw fail('bad_request', `Invalid command name "${spec.name}": use 1–32 letters, digits, "_" or "-", starting with a letter or digit, no slash.`)
    }
    for (const name of this.registered) this.bot.removeCommand(name)
    this.registered = new Set()
    for (const spec of specs) {
      try {
        this.bot.command(spec.name, spec.description, (ctx) => this.command(ctx),
          { usage: spec.usage, options: spec.options, role: spec.role, permission: spec.permission })
      } catch (e) {
        throw fail('bad_request', (e as Error).message)
      }
      this.registered.add(spec.name.toLowerCase())
    }
    return { commands: this.bot.commandList.map((c) => c.name) }
  }

  private command(ctx: CommandContext): void {
    this.emit('command', {
      command: ctx.command.name, args: ctx.args, options: ctx.options, user: ctx.user, userName: ctx.userName, channelId: ctx.channelId,
      dm: ctx.dm, private: ctx.interaction?.private ?? false, ...(ctx.message ? { messageId: ctx.message.id } : {}),
    }, { kind: 'command', ctx })
  }

  private ref(body: Record<string, unknown>): Answerable {
    const found = typeof body.ref === 'string' ? this.refs.get(body.ref) : undefined
    if (!found || Date.now() - found.at > REF_TTL_MS) throw fail('unknown_ref', 'That "ref" is unknown or older than 15 minutes.')
    return found.target
  }

  private emit(event: string, body: unknown, target?: Answerable, type?: string): void {
    let ref: string | undefined
    if (target) {
      ref = `r${++this.nextRef}`
      this.refs.set(ref, { at: Date.now(), target })
      // Oldest first: drop what's expired, and the oldest beyond the cap.
      for (const [key, value] of this.refs) {
        if (this.refs.size <= MAX_REFS && Date.now() - value.at <= REF_TTL_MS) break
        this.refs.delete(key)
      }
    }
    this.write({ event, ...(type !== undefined ? { type } : {}), ...(ref ? { ref } : {}), body })
  }

  private answer(id: unknown, ok: boolean, payload: unknown): void {
    this.write(ok ? { id, ok: true, body: payload ?? {} } : { id, ok: false, error: payload })
  }

  private write(frame: unknown): void {
    try {
      this.options.write(JSON.stringify(frame))
    } catch (e) {
      this.options.log(`Couldn't write to the program: ${(e as Error).message}`)
    }
  }
}

/** A message without the SDK's shortcuts (functions don't go into JSON). */
function plainMessage(message: IncomingMessage): unknown {
  const { reply: _reply, react: _react, channel: _channel, authorName: _name, ...rest } = message
  return rest
}

function errorOf(e: unknown): BridgeError {
  if (e instanceof RequestError) return { code: e.code, message: e.message, ...(e.key ? { key: e.key } : {}), ...(e.args ? { args: e.args } : {}) }
  if (e instanceof BridgeFailure) return { code: e.code, message: e.message }
  return { code: 'failed', message: e instanceof Error ? e.message : String(e) }
}

/**
 * Splits a byte stream into lines (UTF-8, `\n` or `\r\n`), refusing lines over `max` bytes whole: `tooLong` is called
 * once for each, and the rest of it up to the next newline is skipped.
 */
export function readLines(stream: Readable, onLine: (line: string) => void, tooLong: () => void, max = MAX_LINE_BYTES): Promise<void> {
  let parts: Buffer[] = []
  let size = 0
  let skipping = false
  return new Promise((done, failed) => {
    stream.on('data', (chunk: Buffer) => {
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        const piece = chunk.subarray(start, nl === -1 ? chunk.length : nl)
        if (!skipping) {
          size += piece.length
          if (size > max) {
            skipping = true
            parts = []
            tooLong()
          } else parts.push(piece)
        }
        if (nl === -1) break
        if (!skipping) onLine(Buffer.concat(parts).toString('utf8').replace(/\r$/, ''))
        parts = []
        size = 0
        skipping = false
        start = nl + 1
      }
    })
    stream.on('end', () => {
      if (!skipping && size > 0) onLine(Buffer.concat(parts).toString('utf8').replace(/\r$/, ''))
      done()
    })
    stream.on('error', failed)
  })
}

/** Connects a bridge to a program's stdin and stdout: its lines in, the bridge's lines out. */
export function connect(bridge: Bridge, input: Readable, onLineDone?: (p: Promise<void>) => void): Promise<void> {
  return readLines(input, (line) => {
    const p = bridge.line(line)
    onLineDone?.(p)
  }, () => bridge.tooLong())
}

/** Writes lines to a stream, ignoring a program that has gone away (EPIPE). */
export function lineWriter(output: Writable): (line: string) => void {
  output.on('error', () => undefined)
  return (line) => {
    if (!output.destroyed && output.writable) output.write(line + '\n')
  }
}

/**
 * Runs a program with its stdin and stdout connected to the bridge (stderr passes through). Resolves with its exit code.
 * Spawned without a shell, so on Windows name the program's .exe (python, node, dotnet).
 */
export function spawnProgram(command: string, args: string[], bridgeFor: (write: (line: string) => void) => Bridge,
  env: NodeJS.ProcessEnv = process.env): { exited: Promise<number>; kill: () => void } {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env })
  const bridge = bridgeFor(lineWriter(child.stdin!))
  void connect(bridge, child.stdout!).catch(() => undefined)
  const exited = new Promise<number>((done) => {
    child.once('error', (e) => {
      process.stderr.write(`Couldn't start "${command}": ${e.message}\n`)
      done(127)
    })
    child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
  })
  return { exited, kill: () => void child.kill() }
}
