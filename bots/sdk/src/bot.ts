// An Iskra bot: a normal identity that connects with the regular protocol, says it's a bot, and reacts to messages
// and /commands. Reuses the web client's core, so the handshake and crypto are exactly the app's.
import { resolve } from 'node:path'
import { parseCommand, type Command } from '../../../client/src/core/commands'
import { Connection, type ConnectionStatus } from '../../../client/src/core/connection'
import { ready } from '../../../client/src/core/crypto'
import { parseInvite } from '../../../client/src/core/invite'
import { RequestError, type Channel, type Events, type Member, type Message, type Requests } from '../../../client/src/core/protocol'
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
  reply: (text: string) => Promise<Message>
  react: (emoji: string) => Promise<void>
}

export interface CommandContext {
  command: Command
  /** Everything after the command name. */
  args: string
  message: IncomingMessage
  reply: (text: string) => Promise<Message>
  bot: Bot
}

export type CommandHandler = (ctx: CommandContext) => unknown | Promise<unknown>

interface Listeners {
  ready: (bot: Bot) => void
  message: (message: IncomingMessage) => void
  memberJoined: (member: Member) => void
  /** Every server event, for anything the SDK doesn't wrap. */
  event: <K extends keyof Events>(type: K, body: Events[K]) => void
  status: (status: ConnectionStatus) => void
}

const SEND_RETRIES = 4

export class Bot {
  readonly name: string
  me: Member | null = null
  channels: Channel[] = []
  readonly members = new Map<string, Member>()

  private readonly options: BotOptions
  private readonly stateFile: string
  private readonly commands = new Map<string, { description: string; handler: CommandHandler }>()
  private readonly listeners: { [K in keyof Listeners]: Listeners[K][] } = { ready: [], message: [], memberJoined: [], event: [], status: [] }
  private connection: Connection | null = null
  private state: BotState | null = null

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

  /** Answers "/name args". Names are case-insensitive; a later registration replaces an earlier one. */
  command(name: string, description: string, handler: CommandHandler): this {
    const key = name.toLowerCase()
    if (!/^[a-z0-9][\w-]{0,31}$/.test(key)) throw new Error(`Invalid command name "${name}".`)
    this.commands.set(key, { description, handler })
    return this
  }

  helpText(): string {
    const lines = [...this.commands].map(([name, c]) => `\`/${name}\` ${c.description}`)
    return `**${this.name}** can do:\n${lines.join('\n')}`
  }

  /** Connects; resolves once the server has welcomed the bot. Rejects if the server says no. */
  async start(): Promise<void> {
    await ready()
    this.state = loadState(this.stateFile) ?? newState()
    const invite = this.options.invite ? parseInvite(this.options.invite) : null
    if (this.options.invite && !invite) throw new Error("That doesn't look like an Iskra invite link.")
    if (invite && this.state.server?.key !== invite.serverKey) this.state.server = undefined
    const server = this.state.server ?? (invite ? { url: invite.serverUrl, key: invite.serverKey } : null)
    if (!server) throw new Error('No server yet: start the bot once with an invite link from a server admin.')
    saveState(this.stateFile, this.state) // keep the keys even if the first connect fails

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
            this.log(`Rejected by the server: ${status.message}`)
            if (first) fail(new Error(status.message))
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
    this.connection?.stop()
    this.connection = null
  }

  /** Any protocol request (see PROTOCOL.md), for things the SDK doesn't wrap. */
  request<K extends keyof Requests>(type: K, body: Requests[K][0]): Promise<Requests[K][1]> {
    if (!this.connection) return Promise.reject(new RequestError('disconnected', 'The bot is not started.'))
    return this.connection.request(type, body)
  }

  /** Sends a message, waiting and retrying politely if the server says to slow down. */
  async send(channelId: number, text: string, options: { replyTo?: number } = {}): Promise<Message> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.request('chat.send', { channelId, text: text.slice(0, 4000), replyTo: options.replyTo })).message
      } catch (e) {
        if (!(e instanceof RequestError) || e.code !== 'rate_limited' || attempt >= SEND_RETRIES) throw e
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
      }
    }
  }

  async react(messageId: number, emoji: string): Promise<void> {
    await this.request('chat.react', { id: messageId, emoji, on: true })
  }

  /** A mention token that shows as @Name and notifies that member. */
  mention(accountKey: string): string {
    return `<@${accountKey}>`
  }

  channelByName(name: string): Channel | undefined {
    return this.channels.find((c) => c.name === name)
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
    const author = this.members.get(message.author)
    if (!this.options.hearBots && (message.webhook || author?.bot)) return

    const incoming: IncomingMessage = {
      ...message,
      authorName: message.webhook?.name ?? author?.name ?? 'someone',
      channel: this.channels.find((c) => c.id === message.channelId),
      reply: (text) => this.send(message.channelId, text, { replyTo: message.id }),
      react: (emoji) => this.react(message.id, emoji),
    }
    for (const l of this.listeners.message) l(incoming)

    const command = parseCommand(message.text)
    if (!command) return
    // "/roll@Dice" is only for the bot called Dice (spaces in its name may be left out).
    if (command.target && command.target.toLowerCase() !== this.name.replace(/\s+/g, '').toLowerCase()) return
    const entry = this.commands.get(command.name)
    if (!entry) return
    try {
      await entry.handler({ command, args: command.args, message: incoming, reply: incoming.reply, bot: this })
    } catch (e) {
      this.log(`/${command.name} failed: ${(e as Error).message}`)
    }
  }
}
