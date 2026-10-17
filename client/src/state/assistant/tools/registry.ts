// The assistant's tools: a curated, typed list wrapping the same protocol requests the app's own buttons send, so the
// server's permission checks stay the real boundary. Four groups: Search & read (free), Organize (each change approved,
// low-risk ones may be allowed for the session), Moderation and Server admin (off until the user turns them on; every
// call approved). Never tools for keys, recovery codes, tokens, invite links, passkeys, device linking or deleting an
// account. Calls are capped per minute and every call lands in the local "Assistant activity" log.
import type { Category, Role } from '../../../core/protocol'
import type { ServerState } from '../../store'
import type { ThemeFile } from '../../../theme/theme'
import type { HelpSection } from '../helpCorpus'
import { dataBlock } from '../prompt'
import type { ToolSpec } from '../types'

export type ToolCategory = 'read' | 'organize' | 'moderation' | 'admin'
/** read: runs without asking. low: asks, and may be allowed for the rest of the session. write/destructive: asks every time. */
export type Risk = 'read' | 'low' | 'write' | 'destructive'

export class ToolError extends Error {}

/** What a call will do, as the approval card shows it. `summary` is an i18n key under assistant.actions. */
export interface Prepared {
  summary: { key: string; args: Record<string, string | number> }
  /** The exact protocol request it sends (shown raw on the card). */
  request?: { type: string; body: unknown }
  preview?: { theme?: ThemeFile }
  /** Runs it; the text goes back to the model. */
  run(): Promise<string>
  /**
   * Results are wrapped as data for the model (they hold names and words people chose). Only results that are
   * entirely Iskra's own text (the help docs) set this to false.
   */
  untrusted?: boolean
  /** Free text other people will see (names, reasons, rules): shown in full on the approval card. */
  texts?: { field: 'name' | 'reason' | 'rules' | 'theme'; value: string }[]
}

export interface ToolContext {
  host: ToolHost
  /** Null for tools that don't need a server (help, themes, list_servers). */
  server: ServerState | null
  request(type: string, body: unknown): Promise<unknown>
}

export interface ToolDef {
  name: string
  category: ToolCategory
  risk: Risk
  /** Needs a server to act on (the open one, or `server` by name). */
  needsServer: boolean
  /** For the model: what it does and when to use it. */
  description: string
  /** JSON Schema of the arguments (objects only). */
  schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false }
  prepare(args: Record<string, unknown>, ctx: ToolContext): Prepared | Promise<Prepared>
}

export type Decision = 'approve' | 'deny' | 'session'

export interface ApprovalRequest {
  id: string
  tool: string
  category: ToolCategory
  risk: Risk
  source: 'chat' | 'mcp'
  serverName: string | null
  summary: Prepared['summary']
  request?: Prepared['request']
  preview?: Prepared['preview']
  /** Free text others will see, shown in full. */
  texts: NonNullable<Prepared['texts']>
  /** The card may offer "Allow for this session". */
  grantable: boolean
}

export type ActivityStatus = 'done' | 'failed' | 'denied' | 'refused'

export interface ActivityEntry {
  at: number
  tool: string
  category: ToolCategory
  source: 'chat' | 'mcp'
  status: ActivityStatus
  serverName: string | null
  summary: Prepared['summary'] | null
  /** Why it failed or was refused (English, from the server or the guard). */
  detail?: string
}

/** Everything the tools reach: the app's state and connections, the user's approval, and the activity log. */
export interface ToolHost {
  servers(): ServerState[]
  activeServerKey(): string | null
  activeChannelId(serverKey: string): number | null
  categoriesOf(serverKey: string): Category[]
  request(serverKey: string, type: string, body: unknown): Promise<unknown>
  approve(request: ApprovalRequest): Promise<Decision>
  helpSections(): Promise<readonly HelpSection[]>
  applyTheme(theme: ThemeFile): void
  /** Shows a secret (a bot's invite link) to the user in the app; it never goes to the model. */
  showSecret(kind: 'botInvite', serverKey: string, value: string): void
  /** Builds an invite link from a code, for showSecret. */
  inviteLink(server: ServerState, code: string): string
  log(entry: ActivityEntry): void
  enabled(): { moderation: boolean; admin: boolean }
  now(): number
}

/**
 * The only protocol requests tools may send (an allowlist): nothing about keys, invites, webhooks, devices, accounts,
 * backups or sending messages. Anything else is refused before it reaches the connection.
 */
export const ALLOWED_REQUESTS: readonly string[] = [
  'role.list', 'search', 'chat.history',
  'channel.create', 'channel.update', 'channel.move', 'category.create', 'category.update', 'category.move', 'bot.invite',
  'member.timeout', 'member.timeout.remove', 'member.warn', 'member.kick', 'member.ban', 'chat.delete', 'chat.delete.bulk',
  'member.setRole', 'role.create', 'member.roles.set', 'channel.delete', 'rules.update',
]
/** Local-only actions shown on cards like a request (never sent to a server). */
const LOCAL_ACTIONS = ['theme (this device only)']

export const MAX_CALLS_PER_MINUTE = 30
export const MAX_WRITES_PER_MINUTE = 10
/** Changes in one conversation (until New conversation, or the assistant is turned off). */
export const MAX_WRITES_PER_SESSION = 40
/**
 * The only tools "Allow for this session" can cover: they put no new text in front of other people. Everything else
 * asks every time, and MCP clients never get a session grant.
 */
export const SESSION_GRANTABLE: readonly string[] = ['move_channel', 'move_category', 'create_theme']

// ── Lookups shared by the tools ──────────────────────────────────────────────

export const str = (value: unknown, field: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`"${field}" is required.`)
  const text = value.trim()
  if (text.length > max) throw new ToolError(`"${field}" is too long (at most ${max} characters).`)
  return text
}

export const optStr = (value: unknown, field: string, max = 200): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : str(value, field, max)

export const int = (value: unknown, field: string): number => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new ToolError(`"${field}" must be a whole number.`)
  return n
}

const bare = (name: string) => name.replace(/^#/, '').trim().toLowerCase()

/** A channel by id, or by name ("#plans" or "plans"); must be unique. */
export function channelOf(server: ServerState, ref: unknown, field = 'channel') {
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref))) {
    const channel = server.channels.find((c) => c.id === Number(ref))
    if (!channel) throw new ToolError(`No channel with id ${String(ref)} that you can see.`)
    return channel
  }
  const name = bare(str(ref, field, 100))
  const found = server.channels.filter((c) => c.name.toLowerCase() === name)
  if (found.length === 0) throw new ToolError(`No channel named "${name}" that you can see. Use list_channels.`)
  if (found.length > 1) throw new ToolError(`More than one channel is named "${name}"; use its id (list_channels).`)
  return found[0]
}

export function categoryOf(host: ToolHost, server: ServerState, ref: unknown, field = 'category'): Category {
  const categories = host.categoriesOf(server.key)
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref))) {
    const category = categories.find((c) => c.id === Number(ref))
    if (!category) throw new ToolError(`No category with id ${String(ref)}.`)
    return category
  }
  const name = str(ref, field, 100).toLowerCase()
  const found = categories.filter((c) => c.name.toLowerCase() === name)
  if (found.length !== 1) throw new ToolError(found.length ? `More than one category is named "${name}"; use its id.` : `No category named "${name}". Use list_channels.`)
  return found[0]
}

/** A member by account key, or by exact display name (case-insensitive); must be unique. */
export function memberOf(server: ServerState, ref: unknown, field = 'member') {
  const text = str(ref, field, 100).replace(/^@/, '')
  const byKey = server.members[text]
  if (byKey) return byKey
  const found = Object.values(server.members).filter((m) => m.name.toLowerCase() === text.toLowerCase())
  if (found.length === 0) throw new ToolError(`No member named "${text}". Use list_members.`)
  if (found.length > 1) throw new ToolError(`More than one member is named "${text}"; use their accountKey (list_members).`)
  return found[0]
}

export const LEVELS: Role[] = ['guest', 'member', 'trusted', 'admin']

// ── Running calls ────────────────────────────────────────────────────────────

export interface CallResult {
  content: string
  isError: boolean
}

/** Per-minute caps, over a sliding window. */
export class RateCap {
  #calls: { at: number; write: boolean }[] = []
  take(now: number, write: boolean): boolean {
    this.#calls = this.#calls.filter((c) => now - c.at < 60_000)
    if (this.#calls.length >= MAX_CALLS_PER_MINUTE) return false
    if (write && this.#calls.filter((c) => c.write).length >= MAX_WRITES_PER_MINUTE) return false
    this.#calls.push({ at: now, write })
    return true
  }
}

const describeError = (e: unknown): string => {
  if (e instanceof ToolError) return e.message
  const error = e as { message?: unknown; code?: unknown }
  const message = typeof error?.message === 'string' ? error.message : 'Something went wrong.'
  return typeof error?.code === 'string' ? `The server refused (${error.code}): ${message}` : message
}

let approvalIds = 0

export class ToolRunner {
  readonly #tools: Map<string, ToolDef>
  readonly #cap = new RateCap()
  /** "Allow for this session" grants, per tool and server, chat only (cleared by clearSession). */
  readonly #granted = new Set<string>()
  #writes = 0

  readonly host: ToolHost

  constructor(host: ToolHost, tools: readonly ToolDef[]) {
    this.host = host
    this.#tools = new Map(tools.map((t) => [t.name, t]))
  }

  /** A new conversation (or the assistant turned off): grants and the session's change count start over. */
  clearSession(): void {
    this.#granted.clear()
    this.#writes = 0
  }

  /** Whether the card may offer "Allow for this session". */
  static grantable(tool: string, risk: Risk, source: 'chat' | 'mcp'): boolean {
    return source === 'chat' && risk === 'low' && SESSION_GRANTABLE.includes(tool)
  }

  isOn(tool: ToolDef): boolean {
    const on = this.host.enabled()
    return tool.category === 'moderation' ? on.moderation : tool.category === 'admin' ? on.admin : true
  }

  /** The tools a model or MCP client is told about: only the groups that are on. */
  specs(): ToolSpec[] {
    return [...this.#tools.values()].filter((t) => this.isOn(t)).map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
  }

  async call(name: string, rawArgs: unknown, source: 'chat' | 'mcp'): Promise<CallResult> {
    const tool = this.#tools.get(name)
    if (!tool) return { content: `There is no tool called "${name}".`, isError: true }
    const log = (status: ActivityStatus, serverName: string | null, summary: Prepared['summary'] | null, detail?: string) =>
      this.host.log({ at: this.host.now(), tool: name, category: tool.category, source, status, serverName, summary, ...(detail ? { detail } : {}) })

    if (!this.isOn(tool)) {
      const group = tool.category === 'moderation' ? 'Moderation' : 'Server admin'
      const detail = `The ${group} tools are turned off. The user can turn them on in My settings → Assistant.`
      log('refused', null, null, detail)
      return { content: detail, isError: true }
    }
    if (!this.#cap.take(this.host.now(), tool.risk !== 'read')) {
      const detail = `Too many tool calls this minute (at most ${MAX_CALLS_PER_MINUTE}, ${MAX_WRITES_PER_MINUTE} changes). Wait a minute and try again.`
      log('refused', null, null, detail)
      return { content: detail, isError: true }
    }
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : null
    if (!args) return { content: 'The arguments must be a JSON object.', isError: true }

    let server: ServerState | null = null
    let prepared: Prepared
    try {
      if (tool.needsServer) server = this.#serverFor(args.server)
      const ctx: ToolContext = { host: this.host, server, request: (type, body) => this.#send(server, type, body) }
      prepared = await tool.prepare(args, ctx)
    } catch (e) {
      log('failed', server?.name ?? null, null, describeError(e))
      return { content: describeError(e), isError: true }
    }
    if (prepared.request && !ALLOWED_REQUESTS.includes(prepared.request.type) && !LOCAL_ACTIONS.includes(prepared.request.type)) {
      throw new Error(`tool ${name} may not send ${prepared.request.type}`)
    }

    if (tool.risk !== 'read') {
      if (this.#writes >= MAX_WRITES_PER_SESSION) {
        const detail = `This conversation reached its limit of ${MAX_WRITES_PER_SESSION} changes. The user can start a new conversation.`
        log('refused', server?.name ?? null, prepared.summary, detail)
        return { content: detail, isError: true }
      }
      const grant = `${name}|${server?.key ?? ''}`
      const grantable = ToolRunner.grantable(name, tool.risk, source)
      if (!(grantable && this.#granted.has(grant))) {
        const decision = await this.host.approve({
          id: `a${++approvalIds}`, tool: name, category: tool.category, risk: tool.risk, source, serverName: server?.name ?? null,
          summary: prepared.summary, request: prepared.request, preview: prepared.preview, texts: prepared.texts ?? [], grantable,
        })
        if (decision === 'deny') {
          log('denied', server?.name ?? null, prepared.summary)
          return { content: 'The user denied this action. Do not retry it; ask what they want instead.', isError: true }
        }
        if (decision === 'session' && grantable) this.#granted.add(grant)
      }
      this.#writes++
    }

    try {
      const out = await prepared.run()
      log('done', server?.name ?? null, prepared.summary)
      return { content: prepared.untrusted === false ? out : dataBlock(`${name} result`, out), isError: false }
    } catch (e) {
      log('failed', server?.name ?? null, prepared.summary, describeError(e))
      // A server's error can quote names people chose: data too.
      return { content: dataBlock(`${name} error`, describeError(e)), isError: true }
    }
  }

  #serverFor(name: unknown): ServerState {
    const servers = this.host.servers()
    if (name !== undefined && name !== null && name !== '') {
      const wanted = String(name).trim().toLowerCase()
      const found = servers.filter((s) => s.name.toLowerCase() === wanted)
      if (found.length !== 1) throw new ToolError(found.length ? `More than one server is named "${wanted}".` : `You're not on a server named "${wanted}". Use list_servers.`)
      return found[0]
    }
    const key = this.host.activeServerKey()
    const active = servers.find((s) => s.key === key)
    if (!active) throw new ToolError('No server is open. Open one, or name it with "server".')
    return active
  }

  async #send(server: ServerState | null, type: string, body: unknown): Promise<unknown> {
    if (!ALLOWED_REQUESTS.includes(type)) throw new Error(`request ${type} is not allowed for assistant tools`)
    if (!server) throw new ToolError('No server.')
    if (server.status.state !== 'online') throw new ToolError(`${server.name} isn't connected right now.`)
    return this.host.request(server.key, type, body)
  }
}

/** The `server` argument every server tool takes. */
export const SERVER_ARG = { type: 'string', description: 'Server name; leave out for the server the user has open.' }
