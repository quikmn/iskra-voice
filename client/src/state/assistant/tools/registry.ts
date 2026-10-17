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
  /** The text holds other people's words (names, messages): wrapped as data for the model. */
  untrusted?: boolean
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

/** Request types no tool may ever send: secrets, keys, devices, accounts, invites (their codes are secrets). */
export const FORBIDDEN_REQUESTS = [
  'invite.create', 'invite.list', 'invite.revoke', 'webhook.create', 'webhook.list', 'webhook.regenerate', 'webhook.signing.set',
  'outhook.create', 'outhook.list', 'backup.create', 'buddy.add', 'buddy.status', 'p2p.status', 'p2p.rotate', 'p2p.set',
  'account.rotate', 'account.delete', 'device.list', 'device.revoke', 'link.offer', 'link.accept', 'keylog.entries', 'keylog.alert',
  'prefs.get', 'prefs.set', 'gif.configure', 'landing.update', 'member.leave', 'dm.send', 'chat.send', 'security.log.list',
]

export const MAX_CALLS_PER_MINUTE = 30
export const MAX_WRITES_PER_MINUTE = 10

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
  /** Low-risk tools the user allowed for this session (until the app restarts or the assistant is turned off). */
  readonly sessionAllowed = new Set<string>()

  readonly host: ToolHost

  constructor(host: ToolHost, tools: readonly ToolDef[]) {
    this.host = host
    this.#tools = new Map(tools.map((t) => [t.name, t]))
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
    if (prepared.request && FORBIDDEN_REQUESTS.includes(prepared.request.type)) throw new Error(`tool ${name} may not send ${prepared.request.type}`)

    if (tool.risk !== 'read' && !(tool.risk === 'low' && this.sessionAllowed.has(name))) {
      const decision = await this.host.approve({
        id: `a${++approvalIds}`, tool: name, category: tool.category, risk: tool.risk, source, serverName: server?.name ?? null,
        summary: prepared.summary, request: prepared.request, preview: prepared.preview,
      })
      if (decision === 'deny') {
        log('denied', server?.name ?? null, prepared.summary)
        return { content: 'The user denied this action. Do not retry it; ask what they want instead.', isError: true }
      }
      if (decision === 'session' && tool.risk === 'low') this.sessionAllowed.add(name)
    }

    try {
      const out = await prepared.run()
      log('done', server?.name ?? null, prepared.summary)
      return { content: prepared.untrusted ? dataBlock(`${name} result`, out) : out, isError: false }
    } catch (e) {
      log('failed', server?.name ?? null, prepared.summary, describeError(e))
      return { content: describeError(e), isError: true }
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
    if (FORBIDDEN_REQUESTS.includes(type)) throw new Error(`forbidden request ${type}`)
    if (!server) throw new ToolError('No server.')
    if (server.status.state !== 'online') throw new ToolError(`${server.name} isn't connected right now.`)
    return this.host.request(server.key, type, body)
  }
}

/** The `server` argument every server tool takes. */
export const SERVER_ARG = { type: 'string', description: 'Server name; leave out for the server the user has open.' }
