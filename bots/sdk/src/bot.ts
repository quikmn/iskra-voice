// An Iskra bot: a normal identity that connects with the regular protocol, says it's a bot, and reacts to messages
// and /commands. Reuses the web client's core, so the handshake and crypto are exactly the app's.
import { resolve } from 'node:path'
import { parseCommand, type Command } from '../../../client/src/core/commands'
import { Connection, type ConnectionStatus } from '../../../client/src/core/connection'
import { ready } from '../../../client/src/core/crypto'
import { parseInvite } from '../../../client/src/core/invite'
import {
  RequestError, type BotCommand, type Card, type Channel, type CommandOption, type Events, type FileInfo, type Member, type Message, type Poll,
  type Requests, type Thread,
} from '../../../client/src/core/protocol'
import { identityOf, loadState, newState, saveState, type BotState } from './state'

export interface BotOptions {
  /** Display name (1–32 characters). */
  name: string
  /** An invite link from a server admin ("Bots & webhooks" → "Create bot invite"). Only needed the first time. */
  invite?: string
  /** Where the bot keeps its keys and server address. Default: ./<name>.bot.json. Keep it private. */
  stateFile?: string
  /** Also hear other bots and webhooks. Off by default, so two bots can't talk to each other forever. */
  hearBots?: boolean
  /** Where log lines go. Default: console.log. */
  log?: (line: string) => void
}

/** A message the bot received, with shortcuts to answer it. */
export interface IncomingMessage extends Message {
  /** The author's display name (a webhook's name for webhook posts). */
  authorName: string
  channel: Channel | undefined
  reply: (content: string | MessageContent, options?: Omit<SendOptions, 'replyTo'>) => Promise<Message>
  react: (emoji: string) => Promise<void>
}

export interface CommandContext {
  command: Command
  /** Everything after the command name. */
  args: string
  message: IncomingMessage
  reply: (content: string | MessageContent, options?: Omit<SendOptions, 'replyTo'>) => Promise<Message>
  bot: Bot
}

export type CommandHandler = (ctx: CommandContext) => unknown | Promise<unknown>

export interface SendOptions {
  /** Answer this message (same channel). */
  replyTo?: number
  /** Ids of files uploaded with `bot.upload` (up to 10). The text may then be empty. */
  attachments?: string[]
  /** Up to 10 cards (title, description, fields, colour, pictures...). The text may then be empty. */
  cards?: Card[]
}

/** What a message says: text, cards, or both. */
export interface MessageContent extends SendOptions {
  text?: string
}

/** A command for `bot.commands([...])`: what the app shows when people type "/", and what answers it. */
export interface CommandSpec {
  /** 1-32 characters: letters, digits, "_" and "-" (case-insensitive). */
  name: string
  /** 1-100 characters, one line. */
  description: string
  /** A hint shown after the name in the app, like "2d6+1". */
  usage?: string
  /** Up to 25 options, required ones first. The app shows them as hints; the bot still gets the text in `args`. */
  options?: CommandOption[]
  handler: CommandHandler
}

/** A file to send: a name and its bytes (a string is sent as UTF-8). */
export interface OutgoingFile {
  name: string
  data: Uint8Array | string
}

export interface PollOptions {
  /** Let people pick more than one answer. */
  multi?: boolean
  /** Close the poll after this long (1 minute to 14 days). Default: open until someone ends it. */
  durationMs?: number
}

interface Listeners {
  ready: (bot: Bot) => void
  message: (message: IncomingMessage) => void
  memberJoined: (member: Member) => void
  /** A message the bot can see was edited (its own too). */
  messageEdited: (message: Message) => void
  messageDeleted: (deleted: Events['chat.deleted']) => void
  /** The reactions on a message changed; `reactions` is the whole new list. */
  reactions: (change: Events['chat.reactions']) => void
  /** Someone voted, or a poll closed (`poll.closedAt` is then set). */
  pollUpdated: (update: Events['poll.updated']) => void
  /** Every server event, for anything the SDK doesn't wrap. */
  event: <K extends keyof Events>(type: K, body: Events[K]) => void
  status: (status: ConnectionStatus) => void
}

const SEND_RETRIES = 4
const MAX_TEXT = 4000

/** Why the server turned the bot away, in words that say what to do about it. */
export function rejectionHelp(code: string, message: string, joining: boolean): string {
  switch (code) {
    case 'invite_required':
      return joining
        ? "The server didn't accept this invite. A bot needs a bot invite (Bots & webhooks → Bots → Create bot invite): " +
            "an invite for people doesn't work, and each bot invite works once, for 7 days unless the admin chose otherwise."
        : 'This bot is no longer a member of the server (was it removed?). Ask an admin for a new bot invite and start the bot with it.'
    case 'banned':
      return 'This bot is banned from the server.'
    default:
      return message
  }
}

export class Bot {
  readonly name: string
  me: Member | null = null
  channels: Channel[] = []
  readonly members = new Map<string, Member>()

  private readonly options: BotOptions
  private readonly stateFile: string
  private readonly registry = new Map<string, { spec: BotCommand; help: string; handler: CommandHandler }>()
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners: { [K in keyof Listeners]: Listeners[K][] } = {
    ready: [], message: [], memberJoined: [], messageEdited: [], messageDeleted: [], reactions: [], pollUpdated: [], event: [], status: [],
  }
  private connection: Connection | null = null
  private state: BotState | null = null
  private serverUrl = ''

  constructor(options: BotOptions) {
    this.options = options
    this.name = options.name
    this.stateFile = resolve(options.stateFile ?? `${options.name.replace(/[^\w-]+/g, '-').toLowerCase()}.bot.json`)
    this.command('help', 'Lists what this bot can do', ({ reply }) => reply(this.helpText()))
  }

  on<K extends keyof Listeners>(event: K, listener: Listeners[K]): this {
    this.listeners[event].push(listener)
    return this
  }

  /**
   * Answers "/name args". Names are case-insensitive; a later registration replaces an earlier one. The server is
   * told about every command (so the app can suggest it when people type "/") each time the bot connects.
   */
  command(name: string, description: string, handler: CommandHandler, details: { usage?: string; options?: CommandOption[] } = {}): this {
    const key = name.toLowerCase()
    if (!/^[a-z0-9][\w-]{0,31}$/.test(key))
      throw new Error(`Invalid command name "${name}": use 1–32 letters, digits, "_" or "-", starting with a letter or digit, no slash.`)
    // The app shows one line of up to 100 characters; /help shows the description as written.
    const line = description.replace(/\s+/g, ' ').trim() || key
    const spec: BotCommand = { name: key, description: line.length > 100 ? `${line.slice(0, 99)}…` : line }
    if (details.usage) spec.usage = details.usage
    if (details.options?.length) spec.options = details.options
    this.registry.set(key, { spec, help: description, handler })
    this.scheduleSync()
    return this
  }

  /** Several commands at once, with their options: `bot.commands([{ name, description, options, handler }, ...])`. */
  commands(list: CommandSpec[]): this {
    for (const c of list) this.command(c.name, c.description, c.handler, { usage: c.usage, options: c.options })
    return this
  }

  /** The commands as the server knows them. */
  get commandList(): BotCommand[] {
    return [...this.registry.values()].map((c) => c.spec)
  }

  /** Tells the server the commands (done by itself on connect and after changes). */
  async syncCommands(): Promise<void> {
    if (!this.connection || !this.me) return
    try {
      await this.request('bot.commands.set', { commands: this.commandList })
    } catch (e) {
      if (e instanceof RequestError && e.code === 'unknown_type') return // an older server: commands still work as text
      const code = e instanceof RequestError ? ` (${e.code})` : ''
      this.log(`The server didn't take the command list${code}: ${(e as Error).message}`)
    }
  }

  private scheduleSync(): void {
    if (!this.me || this.syncTimer) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.syncCommands()
    }, 200)
  }

  helpText(): string {
    const lines = [...this.registry].map(([name, c]) => `\`/${name}${c.spec.usage ? ` ${c.spec.usage}` : ''}\` ${c.help}`)
    return `**${this.name}** can do:\n${lines.join('\n')}`
  }

  /** Connects; resolves once the server has welcomed the bot. Rejects if the server says no. */
  async start(): Promise<void> {
    await ready()
    this.state = loadState(this.stateFile) ?? newState()
    const invite = this.options.invite ? parseInvite(this.options.invite) : null
    if (this.options.invite && !invite)
      throw new Error("That doesn't look like an Iskra invite link. Copy the whole link from Bots & webhooks → Bots (it contains \"#/join/\").")
    if (invite && this.state.server?.key !== invite.serverKey) this.state.server = undefined
    const server = this.state.server ?? (invite ? { url: invite.serverUrl, key: invite.serverKey } : null)
    if (!server)
      throw new Error(`No server yet: start the bot once with a bot invite link from a server admin (ISKRA_INVITE). It's then remembered in ${this.stateFile}.`)
    saveState(this.stateFile, this.state) // keep the keys even if the first connect fails
    this.serverUrl = server.url.replace(/\/+$/, '')
    const joining = !this.state.server

    let first = true
    await new Promise<void>((done, fail) => {
      let restartLogged = 0
      this.connection = new Connection({
        serverUrl: server.url,
        expectedServerKey: server.key,
        invite: this.state!.server ? undefined : invite?.code,
        identity: identityOf(this.state!),
        name: () => this.name,
        bot: true,
        onStatus: (status) => {
          for (const l of this.listeners.status) l(status)
          if (status.state === 'rejected') {
            const help = rejectionHelp(status.code, status.message, joining)
            this.log(`Rejected by the server: ${help}`)
            if (first) fail(Object.assign(new Error(help), { code: status.code }))
          } else if (status.state === 'offline') {
            this.log(`Disconnected; retrying in ${Math.round(status.retryInMs / 1000)}s`)
          } else if (status.state === 'restarting' && status.since !== restartLogged) {
            restartLogged = status.since // it's reported on every quick retry; say it once
            this.log('The server is restarting; reconnecting as soon as it is back')
          }
        },
        onWelcome: (welcome) => {
          this.me = welcome.you
          this.channels = welcome.channels
          this.members.clear()
          for (const m of welcome.members) this.members.set(m.accountKey, m)
          if (!this.state!.server) {
            this.state!.server = server
            saveState(this.stateFile, this.state!)
          }
          this.log(`Online in "${welcome.server.name}" as ${welcome.you.name} (${welcome.you.role})`)
          void this.syncCommands()
          for (const l of this.listeners.ready) l(this)
          if (first) {
            first = false
            done()
          }
        },
        onEvent: (type, body) => this.handleEvent(type, body),
      })
      this.connection.start()
    })
  }

  stop(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = null
    this.connection?.stop()
    this.connection = null
  }

  /** Any protocol request (see PROTOCOL.md), for things the SDK doesn't wrap. */
  request<K extends keyof Requests>(type: K, body: Requests[K][0]): Promise<Requests[K][1]> {
    if (!this.connection) return Promise.reject(new RequestError('disconnected', 'The bot is not started.'))
    return this.connection.request(type, body)
  }

  /**
   * Sends a message: text (up to 4000 characters; longer text is cut), or `{ text?, cards?, attachments?, replyTo? }`.
   * Waits and retries politely if the server says to slow down.
   */
  send(channelId: number, content: string | MessageContent, options: SendOptions = {}): Promise<Message> {
    const { text = '', ...rest } = typeof content === 'string' ? { text: content } : content
    const merged: SendOptions = { ...options, ...rest }
    if (text.length > MAX_TEXT) this.log(`A message had ${text.length} characters; only the first ${MAX_TEXT} were sent.`)
    return this.retrying(async () =>
      (await this.request('chat.send', {
        channelId, text: text.slice(0, MAX_TEXT), replyTo: merged.replyTo, attachments: merged.attachments, cards: merged.cards,
      })).message)
  }

  /** Changes one of the bot's own messages: new text, or `{ text?, cards? }` (cards replace the old ones; `[]` removes them). */
  async edit(messageId: number, content: string | { text?: string; cards?: Card[] }): Promise<Message> {
    const { text, cards } = typeof content === 'string' ? { text: content, cards: undefined } : content
    return (await this.request('chat.edit', { id: messageId, text: text?.slice(0, MAX_TEXT), cards })).message
  }

  /** Deletes a message: the bot's own, or someone else's if its role allows (manage messages, ranked above the author). */
  async delete(messageId: number): Promise<void> {
    await this.request('chat.delete', { id: messageId })
  }

  /** Adds a reaction, or takes it away with `on = false`. */
  async react(messageId: number, emoji: string, on = true): Promise<void> {
    await this.retrying(() => this.request('chat.react', { id: messageId, emoji, on }))
  }

  /** Uploads a file (up to the server's upload limit), ready for `send(..., { attachments: [file.id] })`. */
  async upload(file: OutgoingFile): Promise<FileInfo> {
    const bytes = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data
    if (bytes.length === 0) throw new Error(`"${file.name}" is empty; files need at least 1 byte.`)
    const ticket = await this.retrying(() => this.request('upload.begin', { name: file.name, size: bytes.length }))
    const target = this.serverUrl + ticket.url
    const partBytes = ticket.partBytes ?? bytes.length
    for (let offset = 0; ; ) {
      const part = bytes.slice(offset, offset + partBytes) // a copy: fetch wants an ArrayBuffer-backed view
      const whole = offset === 0 && part.length === bytes.length
      const response = await fetch(whole ? target : `${target}?offset=${offset}`, { method: 'PUT', body: part })
      if (!response.ok) throw new Error(`Uploading "${file.name}" failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
      const answer = (await response.json()) as { file?: FileInfo; received?: number }
      if (answer.file) return answer.file
      offset = answer.received ?? offset + part.length
    }
  }

  /** Uploads a file and posts it, with optional text. */
  async sendFile(channelId: number, file: OutgoingFile, options: { text?: string; replyTo?: number } = {}): Promise<Message> {
    const uploaded = await this.upload(file)
    return this.send(channelId, options.text ?? '', { replyTo: options.replyTo, attachments: [uploaded.id] })
  }

  /** Starts a poll (2–10 answers of 1–55 characters). Votes arrive as `pollUpdated`. */
  async poll(channelId: number, question: string, answers: string[], options: PollOptions = {}): Promise<Message & { poll: Poll }> {
    const { message } = await this.retrying(() =>
      this.request('poll.create', { channelId, question, options: answers, multi: options.multi, durationMs: options.durationMs }))
    return message as Message & { poll: Poll }
  }

  /** Starts a thread from a message; post in it with `send(thread.id, ...)`. */
  async thread(messageId: number, name: string): Promise<Thread> {
    return (await this.request('thread.create', { messageId, name })).thread
  }

  /** Shows an activity ("Playing …") under the bot's name; null clears it. */
  async setActivity(name: string | null): Promise<void> {
    await this.request('activity.set', { name })
  }

  /** A mention token that shows as @Name and notifies that member. */
  mention(accountKey: string): string {
    return `<@${accountKey}>`
  }

  channelByName(name: string): Channel | undefined {
    return this.channels.find((c) => c.name === name)
  }

  /** Runs a request again (up to 4 more times, waiting longer each time) while the server answers `rate_limited`. */
  private async retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run()
      } catch (e) {
        if (!(e instanceof RequestError) || e.code !== 'rate_limited' || attempt >= SEND_RETRIES) throw e
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
      }
    }
  }

  private log(line: string): void {
    ;(this.options.log ?? console.log)(`[${this.name}] ${line}`)
  }

  private handleEvent<K extends keyof Events>(type: K, body: Events[K]): void {
    for (const l of this.listeners.event) l(type, body)
    switch (type) {
      case 'chat.message':
        void this.handleMessage((body as Events['chat.message']).message)
        return
      case 'chat.edited':
        for (const l of this.listeners.messageEdited) l((body as Events['chat.edited']).message)
        return
      case 'chat.deleted':
        for (const l of this.listeners.messageDeleted) l(body as Events['chat.deleted'])
        return
      case 'chat.reactions':
        for (const l of this.listeners.reactions) l(body as Events['chat.reactions'])
        return
      case 'poll.updated':
        for (const l of this.listeners.pollUpdated) l(body as Events['poll.updated'])
        return
      case 'channels':
        this.channels = (body as Events['channels']).channels
        return
      case 'member.joined':
      case 'member.updated': {
        const { member } = body as Events['member.joined']
        this.members.set(member.accountKey, member)
        if (member.accountKey === this.me?.accountKey) this.me = member
        if (type === 'member.joined') for (const l of this.listeners.memberJoined) l(member)
        return
      }
      case 'member.removed':
        this.members.delete((body as Events['member.removed']).accountKey)
        return
      case 'kicked':
        this.log(`Removed from the server: ${(body as Events['kicked']).reason}`)
        return
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author === this.me?.accountKey) return
    // End-to-end encrypted channels: only people's devices hold the keys, so a bot has nothing to read there.
    if (message.e2ee) return
    const author = this.members.get(message.author)
    if (!this.options.hearBots && (message.webhook || author?.bot)) return

    const reply = (content: string | MessageContent, options?: Omit<SendOptions, 'replyTo'>) =>
      this.send(message.channelId, content, { ...options, replyTo: message.id })
    const incoming: IncomingMessage = {
      ...message,
      authorName: message.webhook?.name ?? author?.name ?? 'someone',
      channel: this.channels.find((c) => c.id === message.channelId),
      reply,
      react: (emoji) => this.react(message.id, emoji),
    }
    for (const l of this.listeners.message) l(incoming)

    const command = parseCommand(message.text)
    if (!command) return
    // "/roll@Dice" is only for the bot called Dice (spaces in its name may be left out).
    if (command.target && command.target.toLowerCase() !== this.name.replace(/\s+/g, '').toLowerCase()) return
    const entry = this.registry.get(command.name)
    if (!entry) return
    try {
      await entry.handler({ command, args: command.args, message: incoming, reply, bot: this })
    } catch (e) {
      const code = e instanceof RequestError ? ` (${e.code})` : ''
      this.log(`/${command.name} failed${code}: ${(e as Error).message}`)
    }
  }
}
