// The personal assistant (bring your own AI): settings, the conversation, approval cards, the activity log and the
// desktop app's local MCP bridge. Off by default. Iskra never provides or proxies AI: the app talks to the provider the
// user chose, straight from this device, and only when they press Send (or a local MCP client they set up calls a tool).
import { create } from 'zustand'
import { useApp, connectionFor, type ServerState } from '../store'
import { useOrganize } from '../organize'
import * as storage from '../../core/storage'
import { buildInviteLink } from '../../core/invite'
import { appUrl } from '../../ui/format'
import { chooseTheme, type ThemeFile } from '../../theme/theme'
import { currentLanguage } from '../../i18n'
import { desktop } from '../../platform/desktop'
import { duration, log } from '../../core/log'
import { fetchTransport, isConfigured, listModels, ProviderError, type Transport } from './providers'
import { runLoop } from './loop'
import { systemPrompt } from './prompt'
import { HELP_DOCS, type HelpSection } from './helpCorpus'
import { ALL_TOOLS } from './tools'
import { ToolRunner, type ActivityEntry, type ApprovalRequest, type Decision, type ToolHost } from './tools/registry'
import { DEFAULT_CONFIG, type AssistantConfig, type Turn } from './types'

const MAX_ACTIVITY = 200

export interface ShownSecret {
  id: string
  kind: 'botInvite'
  serverName: string
  value: string
}

interface AssistantState {
  loaded: boolean
  config: AssistantConfig
  open: boolean
  tab: 'chat' | 'activity'
  turns: Turn[]
  busy: boolean
  error: { code: string; detail?: string } | null
  /** How the last send ended, when it wasn't a plain answer. */
  ended: 'steps' | 'refusal' | 'length' | null
  approvals: ApprovalRequest[]
  secrets: ShownSecret[]
  activity: ActivityEntry[]
  /** Desktop app: what an MCP client runs, once the bridge is on. */
  mcpCommand: string[] | null
}

export const useAssistant = create<AssistantState>(() => ({
  loaded: false,
  config: DEFAULT_CONFIG,
  open: false,
  tab: 'chat',
  turns: [],
  busy: false,
  error: null,
  ended: null,
  approvals: [],
  secrets: [],
  activity: [],
  mcpCommand: null,
}))

const resolvers = new Map<string, (decision: Decision) => void>()
let help: Promise<readonly HelpSection[]> | null = null
let ids = 0

/** The desktop app sends requests from its main process; elsewhere fetch (Anthropic then needs its browser header). */
const viaDesktop = () => !!desktop?.assistant
const transport: Transport = async (request, signal) => {
  if (!desktop?.assistant) return fetchTransport(request, signal)
  if (signal?.aborted) throw new ProviderError('cancelled')
  const reply = await desktop.assistant.fetch(request)
  if (signal?.aborted) throw new ProviderError('cancelled')
  if (!reply.ok) throw new ProviderError(reply.error === 'blocked' ? 'blocked' : reply.error === 'timeout' ? 'timeout' : 'network', undefined, reply.error)
  return { status: reply.status, body: reply.body }
}

let saveActivity: ReturnType<typeof setTimeout> | null = null

const host: ToolHost = {
  servers: () => {
    const { servers, order } = useApp.getState()
    return order.map((key) => servers[key]).filter((s): s is ServerState => !!s)
  },
  activeServerKey: () => useApp.getState().activeServer,
  activeChannelId: (key) => useApp.getState().activeChannel[key] ?? null,
  categoriesOf: (key) => useOrganize.getState().categories[key] ?? [],
  request: (key, type, body) => {
    const connection = connectionFor(key)
    if (!connection) return Promise.reject(new Error('Not connected.'))
    return (connection.request as (type: string, body: unknown) => Promise<unknown>)(type, body)
  },
  approve: (request) => new Promise<Decision>((resolve) => {
    resolvers.set(request.id, resolve)
    useAssistant.setState((s) => ({ approvals: [...s.approvals, request], open: true, tab: 'chat' }))
  }),
  helpSections: () => (help ??= import('virtual:iskra-help').then((m) => m.default, (e) => {
    help = null
    throw e
  })),
  applyTheme: (theme: ThemeFile) => chooseTheme({ custom: theme }),
  showSecret: (kind, serverKey, value) => {
    const serverName = useApp.getState().servers[serverKey]?.name ?? ''
    useAssistant.setState((s) => ({ secrets: [...s.secrets, { id: `s${++ids}`, kind, serverName, value }] }))
  },
  inviteLink: (server, code) => buildInviteLink(appUrl(server.appUrl), { serverUrl: server.directUrl, serverKey: server.key, code }),
  log: (entry) => {
    // Only the tool's name and how it went: never arguments, names or text.
    log('INFO', 'ai', 'tool', null, [['op', entry.tool], ['state', entry.status], ['via', entry.source]])
    useAssistant.setState((s) => ({ activity: [entry, ...s.activity].slice(0, MAX_ACTIVITY) }))
    if (saveActivity) clearTimeout(saveActivity)
    saveActivity = setTimeout(() => void storage.saveAssistant('activity', useAssistant.getState().activity).catch(() => undefined), 500)
  },
  enabled: () => {
    const { config } = useAssistant.getState()
    return { moderation: config.enabled && config.moderation, admin: config.enabled && config.admin }
  },
  now: () => Date.now(),
}

export const runner = new ToolRunner(host, ALL_TOOLS)

/** Answers an approval card. "session" only counts for low-risk tools (the runner checks). */
export function decide(id: string, decision: Decision): void {
  resolvers.get(id)?.(decision)
  resolvers.delete(id)
  useAssistant.setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
}

function denyAll(): void {
  for (const id of [...resolvers.keys()]) decide(id, 'deny')
}

export const openAssistant = () => useAssistant.setState({ open: true })
export const closeAssistant = () => useAssistant.setState({ open: false })
export const dismissSecret = (id: string) => useAssistant.setState((s) => ({ secrets: s.secrets.filter((x) => x.id !== id) }))

export function clearActivity(): void {
  useAssistant.setState({ activity: [] })
  void storage.clearAssistant('activity').catch(() => undefined)
}

// ── Settings ───────────────────────────────────────────────────────────────────

export function parseConfig(raw: unknown): AssistantConfig {
  const c = (raw ?? {}) as Partial<AssistantConfig>
  const kind = c.kind === 'openai' ? 'openai' : 'anthropic'
  return {
    ...DEFAULT_CONFIG,
    enabled: c.enabled === true,
    preset: typeof c.preset === 'string' ? c.preset : DEFAULT_CONFIG.preset,
    kind,
    baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : DEFAULT_CONFIG.baseUrl,
    model: typeof c.model === 'string' ? c.model : DEFAULT_CONFIG.model,
    key: typeof c.key === 'string' ? c.key : '',
    moderation: c.moderation === true,
    admin: c.admin === true,
    mcp: c.mcp === true,
  }
}

async function loadConfig(): Promise<void> {
  try {
    const [config, activity] = await Promise.all([storage.loadAssistant<unknown>('config'), storage.loadAssistant<ActivityEntry[]>('activity')])
    useAssistant.setState({ loaded: true, config: parseConfig(config), activity: Array.isArray(activity) ? activity.slice(0, MAX_ACTIVITY) : [] })
  } catch {
    useAssistant.setState({ loaded: true })
  }
  void syncMcp()
}

export async function saveConfig(patch: Partial<AssistantConfig>): Promise<void> {
  const before = useAssistant.getState().config
  const config = parseConfig({ ...before, ...patch })
  // Another provider can't read this one's conversation (thinking blocks, tool call formats): start over.
  const fresh = config.kind !== before.kind || config.baseUrl !== before.baseUrl || config.model !== before.model
  if (!config.enabled) {
    denyAll()
    runner.sessionAllowed.clear()
  }
  useAssistant.setState((s) => ({ config, ...(fresh || !config.enabled ? { turns: [], error: null, ended: null } : {}), open: config.enabled && s.open }))
  await storage.saveAssistant('config', config)
  void syncMcp()
}

/** "Test connection": the models the key can use, or a ProviderError. */
export const testConnection = (config: AssistantConfig) => listModels({ ...config, enabled: true }, transport, !viaDesktop())

/** Where requests go, for the privacy line. */
export { providerHost } from './url'

// ── The conversation ───────────────────────────────────────────────────────────

let abort: AbortController | null = null

function context() {
  const app = useApp.getState()
  const server = app.activeServer ? app.servers[app.activeServer] : null
  const channel = server ? server.channels.find((c) => c.id === app.activeChannel[server.key]) : null
  const { config } = useAssistant.getState()
  return {
    language: currentLanguage(),
    server: server ? { name: server.name, role: server.me?.role ?? 'member' } : null,
    channel: channel ? { name: channel.name, encrypted: !!channel.e2ee } : null,
    categories: { moderation: config.moderation, admin: config.admin },
    helpTopics: HELP_DOCS.map((d) => d.doc),
  }
}

export async function sendToAssistant(text: string): Promise<void> {
  const message = text.trim()
  const state = useAssistant.getState()
  if (!message || state.busy || !isConfigured(state.config)) return
  const turns: Turn[] = [...state.turns, { role: 'user', text: message.slice(0, 20_000) }]
  abort = new AbortController()
  useAssistant.setState({ turns, busy: true, error: null, ended: null })
  const started = Date.now()
  let steps = 0
  try {
    const end = await runLoop({
      config: state.config,
      system: systemPrompt(context()),
      turns,
      runner,
      transport,
      browser: !viaDesktop(),
      signal: abort.signal,
      onTurn: (turn) => {
        if (turn.role === 'assistant') steps++
        useAssistant.setState((s) => ({ turns: [...s.turns, turn] }))
      },
    })
    log('INFO', 'ai', 'answered', null, [['kind', state.config.kind], ['n', steps], ['state', end], ['took', duration(Date.now() - started)]])
    if (end === 'steps' || end === 'refusal' || end === 'length') useAssistant.setState({ ended: end })
  } catch (e) {
    const error = e instanceof ProviderError ? e : new ProviderError('network', undefined, e instanceof Error ? e.message : undefined)
    if (error.code !== 'cancelled') {
      log('WARN', 'ai', 'failed', 'AI-110', [['kind', state.config.kind], ['why', error.code.replace('_', '-')], ['status', error.status]])
      useAssistant.setState({ error: { code: error.code, detail: error.detail } })
    }
    // The last user message didn't get an answer: keep the history valid for the next send.
    useAssistant.setState((s) => ({ turns: validHistory(s.turns) }))
  } finally {
    abort = null
    useAssistant.setState({ busy: false })
  }
}

/** Drops a trailing assistant tool call without results (a failed send), so the next request is well-formed. */
export function validHistory(turns: Turn[]): Turn[] {
  const last = turns[turns.length - 1]
  if (last?.role === 'assistant' && last.toolCalls.length) return turns.slice(0, -1)
  return turns
}

export function stopAssistant(): void {
  abort?.abort()
  denyAll()
}

export function newConversation(): void {
  stopAssistant()
  useAssistant.setState({ turns: [], error: null, ended: null, secrets: [] })
}

// ── The desktop app's local MCP bridge ─────────────────────────────────────────

async function syncMcp(): Promise<void> {
  const { config } = useAssistant.getState()
  const reply = await desktop?.assistant?.setMcp(config.enabled && config.mcp).catch(() => null)
  useAssistant.setState({ mcpCommand: reply?.on ? reply.command : null })
}

export async function mcpRequest(method: string, name: unknown, args: unknown): Promise<unknown> {
  const { config } = useAssistant.getState()
  if (!config.enabled || !config.mcp) return { error: 'off' }
  if (method === 'list') return { tools: runner.specs() }
  if (method === 'call' && typeof name === 'string') return runner.call(name, args ?? {}, 'mcp')
  return { error: 'bad_request' }
}

if (desktop?.assistant) {
  desktop.assistant.onMcp((request) => {
    void mcpRequest(request.method, request.name, request.args).then(
      (result) => desktop!.assistant!.mcpReply(request.id, result),
      () => desktop!.assistant!.mcpReply(request.id, { error: 'failed' }),
    )
  })
}

// Settings are sealed with the device's keys: read them once the vault is open.
useApp.subscribe((state, previous) => {
  if (state.phase === 'ready' && previous.phase !== 'ready' && !useAssistant.getState().loaded) void loadConfig()
})
if (useApp.getState().phase === 'ready') void loadConfig()
