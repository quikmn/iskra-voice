// An Iskra bot: a normal identity that connects with the regular protocol, says it's a bot, and answers /commands
// (as interactions from the app, or typed as text), button clicks and forms, and messages meant for it.
// Reuses the web client's core, so the handshake and crypto are exactly the app's.
import { resolve } from 'node:path'
import { parseCommand, type Command } from '../../../client/src/core/commands'
import { Connection, type ConnectionStatus } from '../../../client/src/core/connection'
import { ready } from '../../../client/src/core/crypto'
import { parseInvite } from '../../../client/src/core/invite'
import {
  RequestError, type BotCommand, type Card, type Channel, type CommandOption, type ComponentRow, type Events, type FileInfo, type Interaction,
  type Member, type Message, type Modal, type OptionValue, type Poll, type Requests, type Thread,
} from '../../../client/src/core/protocol'
import { identityOf, loadState, newState, saveState, type BotState } from './state'
import { VoiceConnection } from './voice/connection'

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

/** How to answer: in public (a message in the channel), or `private: true` so only the person who asked sees it. */
export interface ReplyOptions extends Omit<SendOptions, 'replyTo' | 'attachments'> {
  /** Only the person who asked sees it; never stored (always so in encrypted channels). Ignored for commands typed as text. */
  private?: boolean
}

/** What every answerable context has: who asked, where, and how to answer. */
export interface AnswerContext {
  /** Who asked (account key) and their name. */
  user: string
  userName: string
  channelId: number
  /** The interaction, when it came from the app (null for commands typed as text). */
  interaction: Interaction | null
  /**
   * Answers. Returns the posted message, or null for a private answer. Up to 5 answers per interaction, within 15
   * minutes; the first should come within 3 seconds or the app shows "thinking" (call `defer()` for slow work).
   */
  reply: (content: string | MessageContent, options?: ReplyOptions) => Promise<Message | null>
  /** "I'm working on it": the app shows "<bot> is thinking…" until you reply (up to 15 minutes). */
  defer: () => Promise<void>
  /** Shows a form to the person who asked; its answer arrives at `bot.onModalSubmit(modal.customId, ...)`. */
  showModal: (modal: Modal) => Promise<void>
  bot: Bot
}

export interface CommandContext extends AnswerContext {
  command: Command
  /** Everything after the command name, as typed. */
  args: string
  /** The command's options, checked by the server against what you declared (empty for commands typed as text). */
  options: Record<string, OptionValue>
  /** The message, for commands typed as text (undefined when the app sent the command as an interaction). */
  message?: IncomingMessage
  /** Reacts to the command's message (does nothing for interactions, which have no message). */
  react: (emoji: string) => Promise<void>
}

/** A click on one of the bot's buttons or select menus. */
export interface ComponentContext extends AnswerContext {
  customId: string
  /** The picked values (select menus). */
  values: string[]
  /** The message the component is on (or the private answer's id). */
  messageId?: number
  responseId?: string
  /** Replaces the text, cards and components of the message (or private answer) the click came from. */
  update: (content: string | MessageContent) => Promise<void>
}

/** A form the bot showed, filled in. */
export interface ModalContext extends AnswerContext {
  customId: string
  /** Field customId → what was typed ("" for empty optional fields). */
  fields: Record<string, string>
}

export type ComponentHandler = (ctx: ComponentContext) => unknown | Promise<unknown>
export type ModalHandler = (ctx: ModalContext) => unknown | Promise<unknown>

export type CommandHandler = (ctx: CommandContext) => unknown | Promise<unknown>

export interface SendOptions {
  /** Answer this message (same channel). */
  replyTo?: number
  /** Ids of files uploaded with `bot.upload` (up to 10). The text may then be empty. */
  attachments?: string[]
  /** Up to 10 cards (title, description, fields, colour, pictures...). The text may then be empty. */
  cards?: Card[]
  /** Up to 5 rows of buttons or a select menu; clicks arrive at `bot.onComponent`. The text may then be empty. */
  components?: ComponentRow[]
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
  /** Up to 25 options, required ones first. The app checks them and the server too; you get them in `options` (and the text in `args`). */
  options?: CommandOption[]
  /** The lowest level that may use it (enforced by the server). */
  role?: 'member' | 'trusted' | 'admin'
  /** A permission the person needs, like 'manageMessages' (enforced by the server; admins have all). */
  permission?: string
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
  private readonly componentHandlers: { match: string | RegExp; handler: ComponentHandler }[] = []
  private readonly modalHandlers: { match: string | RegExp; handler: ModalHandler }[] = []
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners: { [K in keyof Listeners]: Listeners[K][] } = {
    ready: [], message: [], memberJoined: [], messageEdited: [], messageDeleted: [], reactions: [], pollUpdated: [], event: [], status: [],
  }
  private connection: Connection | null = null
  private voiceConnection: VoiceConnection | null = null
  /** Who is in which voice channel (the channels the bot can see), from the server. */
  private readonly inVoice = new Map<number, string[]>()
  private state: BotState | null = null
  private serverUrl = ''

  constructor(options: BotOptions) {
    this.options = options
    this.name = options.name
    this.stateFile = resolve(options.stateFile ?? `${options.name.replace(/[^\w-]+/g, '-').toLowerCase()}.bot.json`)
    this.command('help', 'Lists what this bot can do', ({ reply }) => reply(this.helpText(), { private: true }))
  }

  on<K extends keyof Listeners>(event: K, listener: Listeners[K]): this {
    this.listeners[event].push(listener)
    return this
  }

  /**
   * Answers "/name args". Names are case-insensitive; a later registration replaces an earlier one. The server is
   * told about every command (so the app can suggest it when people type "/") each time the bot connects.
   */
  command(name: string, description: string, handler: CommandHandler,
    details: { usage?: string; options?: CommandOption[]; role?: CommandSpec['role']; permission?: string } = {}): this {
    const key = name.toLowerCase()
    if (!/^[a-z0-9][\w-]{0,31}$/.test(key))
      throw new Error(`Invalid command name "${name}": use 1–32 letters, digits, "_" or "-", starting with a letter or digit, no slash.`)
    // The app shows one line of up to 100 characters; /help shows the description as written.
    const line = description.replace(/\s+/g, ' ').trim() || key
    const spec: BotCommand = { name: key, description: line.length > 100 ? `${line.slice(0, 99)}…` : line }
    if (details.usage) spec.usage = details.usage
    if (details.options?.length) spec.options = details.options
    if (details.role) spec.role = details.role
    if (details.permission) spec.permission = details.permission
    this.registry.set(key, { spec, help: description, handler })
    this.scheduleSync()
    return this
  }

  /** Several commands at once, with their options: `bot.commands([{ name, description, options, handler }, ...])`. */
  commands(list: CommandSpec[]): this {
    for (const c of list) this.command(c.name, c.description, c.handler, { usage: c.usage, options: c.options, role: c.role, permission: c.permission })
    return this
  }

  /**
   * Answers clicks on the bot's buttons and select menus: `customId` exactly, or a pattern (`/^roll:/` for
   * "roll:d6", "roll:2d6"...). The first match answers.
   */
  onComponent(customId: string | RegExp, handler: ComponentHandler): this {
    this.componentHandlers.push({ match: customId, handler })
    return this
  }

  /** Answers forms the bot showed with `showModal({ customId, ... })`. */
  onModalSubmit(customId: string | RegExp, handler: ModalHandler): this {
    this.modalHandlers.push({ match: customId, handler })
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
      // interactions: the app sends commands (with checked options) straight to the bot instead of posting the text.
      await this.request('bot.commands.set', { commands: this.commandList, interactions: true })
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
          this.inVoice.clear()
          for (const v of welcome.voice ?? []) this.inVoice.set(v.channelId, v.participants.map((p) => p.accountKey))
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
    void this.voiceConnection?.leave()
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
        components: merged.components,
      })).message)
  }

  /** Changes one of the bot's own messages: new text, or `{ text?, cards?, components? }` (these replace the old ones; `[]` removes them). */
  async edit(messageId: number, content: string | { text?: string; cards?: Card[]; components?: ComponentRow[] }): Promise<Message> {
    const { text, cards, components } = typeof content === 'string' ? { text: content, cards: undefined, components: undefined } : content
    return (await this.request('chat.edit', { id: messageId, text: text?.slice(0, MAX_TEXT), cards, components })).message
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

  // ── Voice ────────────────────────────────────────────────────────────────

  /**
   * Joins a voice channel to play audio (`voice.play(...)`). An admin must let the bot join voice (Bots & webhooks),
   * and it needs to be able to post in the channel to be heard. Leaves the channel it was in before, if any.
   * Never in stage or end-to-end encrypted channels. The bot never hears anyone: its token can't subscribe.
   */
  async joinVoice(channelId: number): Promise<VoiceConnection> {
    await this.voiceConnection?.leave()
    const joined = await this.request('voice.join', { channelId })
    const connection: VoiceConnection = new VoiceConnection(channelId, this.me!.accountKey, this.serverUrl,
      () => this.channels.find((c) => c.id === channelId), (line) => this.log(line),
      () => {
        if (this.voiceConnection === connection) this.voiceConnection = null
      })
    this.voiceConnection = connection
    try {
      await connection.connect(joined)
    } catch (e) {
      await connection.leave()
      throw e
    }
    return connection
  }

  /** The voice channel someone is in (of those the bot can see), or null: e.g. to join the person who asked. */
  voiceChannelOf(accountKey: string): number | null {
    for (const [channelId, people] of this.inVoice) if (people.includes(accountKey)) return channelId
    return null
  }

  /** The voice channel the bot is in, or null. */
  get voice(): VoiceConnection | null {
    return this.voiceConnection
  }

  /** The full address of a file on the server (an attachment, `/files/<id>/<name>`), e.g. for `voice.play`. */
  fileUrl(file: FileInfo | string): string {
    const path = typeof file === 'string' ? file : file.url
    return /^https?:\/\//i.test(path) ? path : this.serverUrl + path
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
      case 'interaction':
        void this.handleInteraction(body as Events['interaction'])
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
        this.voiceConnection?.removed()
        return
      case 'voice.state': {
        const state = body as Events['voice.state']
        this.inVoice.set(state.channelId, state.participants.map((p) => p.accountKey))
        this.voiceConnection?.voiceState(state)
        return
      }
      case 'voice.disconnected':
        if ((body as Events['voice.disconnected']).channelId === this.voiceConnection?.channelId) this.voiceConnection.removed()
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
    // Typed as text (an older app, or a bot that reads everything): answers are always messages.
    await this.run(`/${command.name}`, () => entry.handler({
      command, args: command.args, options: {}, message: incoming, user: message.author, userName: incoming.authorName,
      channelId: message.channelId, interaction: null,
      reply: (content, options) => reply(content, options && { cards: options.cards, components: options.components }),
      defer: async () => undefined,
      showModal: () => Promise.reject(new Error('Forms only work for commands sent from the app, not typed as text.')),
      react: (emoji) => this.react(message.id, emoji),
      bot: this,
    }))
  }

  // ── Interactions ─────────────────────────────────────────────────────────

  /** Answers an interaction, waiting and retrying politely when rate limited. */
  private respond(id: string, body: Omit<Requests['interaction.respond'][0], 'id'>): Promise<Requests['interaction.respond'][1]> {
    if (body.text && body.text.length > MAX_TEXT) body = { ...body, text: body.text.slice(0, MAX_TEXT) }
    return this.retrying(() => this.request('interaction.respond', { id, ...body }))
  }

  /** What every interaction handler gets: who asked, where, and how to answer. */
  private answering(i: Interaction): AnswerContext {
    return {
      user: i.user,
      userName: this.members.get(i.user)?.name ?? 'someone',
      channelId: i.channelId,
      interaction: i,
      reply: async (content, options = {}) => {
        const { text, cards, components } = { ...(typeof content === 'string' ? { text: content } : content), ...options }
        const answer = await this.respond(i.id, { text, cards, components, private: options.private || i.private || undefined })
        return answer.message ?? null
      },
      defer: async () => {
        await this.respond(i.id, { type: 'defer' })
      },
      showModal: async (modal) => {
        await this.respond(i.id, { type: 'modal', modal })
      },
      bot: this,
    }
  }

  private async handleInteraction(i: Interaction): Promise<void> {
    const base = this.answering(i)
    const matches = (match: string | RegExp, id: string) => (typeof match === 'string' ? match === id : match.test(id))
    if (i.kind === 'command' && i.command) {
      const name = i.command
      const entry = this.registry.get(name)
      if (!entry) return
      const args = i.args ?? ''
      await this.run(`/${name}`, () => entry.handler({
        ...base, command: { name, target: null, args }, args, options: i.options ?? {}, react: async () => undefined,
      }))
    } else if (i.kind === 'component' && i.customId) {
      const customId = i.customId
      const found = this.componentHandlers.find((h) => matches(h.match, customId))
      if (!found) return this.log(`Nothing answers the button "${customId}" (bot.onComponent).`)
      await this.run(`Button ${customId}`, () => found.handler({
        ...base, customId, values: i.values ?? [], messageId: i.messageId, responseId: i.responseId,
        update: async (content) => {
          const { text, cards, components } = typeof content === 'string' ? { text: content } as MessageContent : content
          await this.respond(i.id, { type: 'update', text, cards, components })
        },
      }))
    } else if (i.kind === 'modal' && i.customId) {
      const customId = i.customId
      const found = this.modalHandlers.find((h) => matches(h.match, customId))
      if (!found) return this.log(`Nothing answers the form "${customId}" (bot.onModalSubmit).`)
      await this.run(`Form ${customId}`, () => found.handler({ ...base, customId, fields: i.fields ?? {} }))
    }
  }

  private async run(what: string, handler: () => unknown): Promise<void> {
    try {
      await handler()
    } catch (e) {
      const code = e instanceof RequestError ? ` (${e.code})` : ''
      this.log(`${what} failed${code}: ${(e as Error).message}`)
    }
  }
}
