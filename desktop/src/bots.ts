// "Bots on this PC": the desktop app runs bots as child processes. Gallery bots ship with the app (dist/gallery, built
// from bots/gallery) and run with the app's own Node (ELECTRON_RUN_AS_NODE), so updates come with app updates and
// nothing is downloaded. A bot from a folder runs with the same Node (JavaScript or TypeScript) or the computer's own
// Python. Bots run with the user's rights and only connect out to their server: nothing listens on a port.
// State lives in userData/bots: bots.json (which bots, their settings, autostart) and a folder per bot (its keys and
// data for gallery bots, and bot.log). Invite links are kept in memory only, until the bot has joined.
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface GallerySetting {
  env: string
  kind: 'text' | 'number' | 'secret'
  default: string
}

export interface GalleryBot {
  id: string
  name: string
  /** What the bot invite the app makes for it allows. */
  readAll: boolean
  voice: boolean
  settings: GallerySetting[]
}

export interface BotConfig {
  id: string
  kind: 'gallery' | 'folder'
  /** Gallery bots: which one. */
  gallery?: string
  /** Folder bots: where. */
  folder?: string
  name: string
  autostart: boolean
  /** Gallery bots: environment variables from their declared settings. */
  settings: Record<string, string>
}

export type BotState = 'stopped' | 'starting' | 'running' | 'failed'

export interface BotStatus extends BotConfig {
  state: BotState
  /** Connected to its server (it said "Online in …"). */
  online: boolean
  /** It hasn't joined a server yet (gallery bots without keys): starting needs a bot invite. */
  needsInvite: boolean
  /** Why the last run ended, when it ended by itself: an exit code, or no-entry / no-python / spawn. */
  problem: string | null
}

export type LaunchPlan =
  | { command: string; args: string[]; cwd: string; env: Record<string, string>; runtime: 'node' | 'python' }
  | { error: 'no-entry' }

export const MAX_BOTS = 20
export const LOG_LINES = 300
const MAX_LOG_BYTES = 1024 * 1024
const MAX_LINE = 1000

/** Bot invites the way the app makes them: an address with "#/join/". */
export const isInvite = (v: unknown): v is string => typeof v === 'string' && v.length <= 2000 && /^(https?|iskra):\/\/\S+#\/join\/\S+$/.test(v)

/** The gallery manifest (assets/gallery.json), checked: anything odd is left out. */
export function parseGallery(raw: unknown): GalleryBot[] {
  const list = (raw as { bots?: unknown })?.bots
  if (!Array.isArray(list)) return []
  return list.flatMap((b: Record<string, unknown>) => {
    if (typeof b?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(b.id) || typeof b.name !== 'string') return []
    const settings = (Array.isArray(b.settings) ? b.settings : []).flatMap((s: Record<string, unknown>) =>
      typeof s?.env === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(s.env) && (s.kind === 'text' || s.kind === 'number' || s.kind === 'secret')
        ? [{ env: s.env, kind: s.kind, default: typeof s.default === 'string' ? s.default : '' } as GallerySetting]
        : [])
    return [{ id: b.id, name: b.name, readAll: b.readAll === true, voice: b.voice === true, settings }]
  })
}

/** A bot's display name: 1-32 characters, one line. */
export function cleanName(name: unknown, fallback: string): string {
  const clean = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) : ''
  return clean || fallback
}

/** Only declared settings, as short single-line text (numbers as digits). */
export function cleanSettings(raw: unknown, declared: GallerySetting[]): Record<string, string> {
  const out: Record<string, string> = {}
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  for (const s of declared) {
    const value = given[s.env]
    if (typeof value !== 'string') continue
    const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300)
    if (s.kind === 'number' && text !== '' && !/^\d{1,6}$/.test(text)) continue
    out[s.env] = text
  }
  return out
}

/**
 * What runs a folder bot: package.json's "main", else bot/index/main .js, .mjs, .cjs or .ts (with the app's Node), else
 * bot.py or main.py (with Python). Null when there's nothing to run.
 */
export function findEntry(folder: string, exists: (p: string) => boolean = existsSync, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): { file: string; runtime: 'node' | 'python' } | null {
  const js = /\.(js|mjs|cjs|ts|mts)$/
  try {
    const main = (JSON.parse(read(path.join(folder, 'package.json'))) as { main?: unknown }).main
    if (typeof main === 'string' && js.test(main)) {
      const file = path.resolve(folder, main)
      // Only inside the folder.
      if (file.startsWith(path.resolve(folder) + path.sep) && exists(file)) return { file, runtime: 'node' }
    }
  } catch {
    /* no package.json */
  }
  for (const name of ['bot', 'index', 'main']) {
    for (const ext of ['.js', '.mjs', '.cjs', '.ts']) {
      const file = path.join(folder, name + ext)
      if (exists(file)) return { file, runtime: 'node' }
    }
  }
  for (const name of ['bot.py', 'main.py']) {
    const file = path.join(folder, name)
    if (exists(file)) return { file, runtime: 'python' }
  }
  return null
}

/** The environment a bot gets: the app's, without what would change how Node runs it, plus its own settings. */
export function botEnv(base: NodeJS.ProcessEnv, runtime: 'node' | 'python', extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key === 'NODE_OPTIONS' || key.startsWith('ELECTRON_') || key === 'ISKRA_INVITE') continue
    env[key] = value
  }
  if (runtime === 'node') env.ELECTRON_RUN_AS_NODE = '1'
  env.PYTHONUNBUFFERED = '1' // log lines as they happen
  env.FORCE_COLOR = '0'
  return { ...env, ...extra }
}

export interface RunnerOptions {
  /** userData/bots */
  root: string
  /** The app's executable (process.execPath): Node when run with ELECTRON_RUN_AS_NODE. */
  execPath: string
  /** Where the bundled gallery bots are (dist/gallery, outside the asar archive when packaged). */
  galleryDir: string
  gallery: GalleryBot[]
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Something changed (state, online): the page refreshes its list. */
  onChange?: () => void
  /** The app's own log: a bot started, stopped by itself, or couldn't start (never the bot's own output). */
  onEvent?: (event: 'started' | 'stopped' | 'exited' | 'failed', id: string, detail: string | number | null) => void
}

interface Running {
  child: ChildProcess
  stopping: boolean
  partial: { out: string; err: string }
}

export class BotRunner {
  private configs: BotConfig[] = []
  private readonly running = new Map<string, Running>()
  private readonly states = new Map<string, { state: BotState; online: boolean; problem: string | null }>()
  private readonly logs = new Map<string, string[]>()
  /** Bot invites waiting to be used (memory only): passed as ISKRA_INVITE until the bot is online. */
  private readonly invites = new Map<string, string>()
  private readonly opts: RunnerOptions

  constructor(options: RunnerOptions) {
    this.opts = options
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { bots?: BotConfig[] }
      this.configs = (saved.bots ?? []).filter((b) => typeof b?.id === 'string' && /^[a-z0-9-]{1,60}$/.test(b.id))
    } catch {
      /* none yet */
    }
  }

  private get file(): string {
    return path.join(this.opts.root, 'bots.json')
  }

  private save(): void {
    mkdirSync(this.opts.root, { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ bots: this.configs }, null, 2))
    renameSync(`${this.file}.tmp`, this.file)
  }

  /** A bot's own folder: its keys and data (gallery bots), and bot.log. */
  dataDir(id: string): string {
    return path.join(this.opts.root, id)
  }

  galleryBot(id: string | undefined): GalleryBot | undefined {
    return this.opts.gallery.find((g) => g.id === id)
  }

  list(): BotStatus[] {
    return this.configs.map((c) => this.status(c))
  }

  private status(c: BotConfig): BotStatus {
    const s = this.states.get(c.id) ?? { state: 'stopped' as BotState, online: false, problem: null }
    return { ...c, settings: { ...c.settings }, ...s, needsInvite: this.needsInvite(c) }
  }

  /** Gallery bots keep their keys in their folder: no `*.bot.json` with a server yet means they still need an invite. */
  needsInvite(c: BotConfig): boolean {
    if (c.kind !== 'gallery') return false
    const dir = this.dataDir(c.id)
    try {
      const files = existsSync(dir) ? readdirSync(dir) : []
      return !files.some((f) => f.endsWith('.bot.json') && /"server"\s*:/.test(readFileSync(path.join(dir, f), 'utf8')))
    } catch {
      return true
    }
  }

  /** Adds a gallery bot (by id) or a folder. Returns its status, or null if it can't be added. */
  add(source: { gallery: string } | { folder: string }, name?: unknown): BotStatus | null {
    if (this.configs.length >= MAX_BOTS) return null
    let config: BotConfig
    if ('gallery' in source) {
      const g = this.galleryBot(source.gallery)
      if (!g) return null
      const settings: Record<string, string> = {}
      for (const s of g.settings) if (s.default) settings[s.env] = s.default
      config = { id: this.newId(g.id), kind: 'gallery', gallery: g.id, name: cleanName(name, g.name), autostart: false, settings }
    } else {
      if (!path.isAbsolute(source.folder)) return null
      const base = path.basename(source.folder).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'bot'
      config = { id: this.newId(base), kind: 'folder', folder: source.folder, name: cleanName(name, path.basename(source.folder)), autostart: false, settings: {} }
    }
    this.configs.push(config)
    this.save()
    return this.status(config)
  }

  private newId(base: string): string {
    let id = base
    for (let n = 2; this.configs.some((c) => c.id === id) || existsSync(this.dataDir(id)); n++) id = `${base}-${n}`
    return id
  }

  update(id: string, patch: { name?: unknown; autostart?: unknown; settings?: unknown }): BotStatus | null {
    const c = this.configs.find((b) => b.id === id)
    if (!c) return null
    if (patch.name !== undefined) c.name = cleanName(patch.name, c.name)
    if (typeof patch.autostart === 'boolean') c.autostart = patch.autostart
    if (patch.settings !== undefined && c.kind === 'gallery') c.settings = cleanSettings(patch.settings, this.galleryBot(c.gallery)?.settings ?? [])
    this.save()
    return this.status(c)
  }

  /** How a bot would be started (or why it can't), without starting it. */
  plan(c: BotConfig): LaunchPlan {
    const extra: Record<string, string> = { BOT_NAME: c.name }
    const invite = this.invites.get(c.id)
    if (invite) extra.ISKRA_INVITE = invite
    const env = this.opts.env ?? process.env
    if (c.kind === 'gallery') {
      const script = path.join(this.opts.galleryDir, `${c.gallery}.cjs`)
      return { command: this.opts.execPath, args: [script], cwd: this.dataDir(c.id), env: botEnv(env, 'node', { ...c.settings, ...extra }), runtime: 'node' }
    }
    const entry = findEntry(c.folder!)
    if (!entry) return { error: 'no-entry' }
    if (entry.runtime === 'node') return { command: this.opts.execPath, args: [entry.file], cwd: c.folder!, env: botEnv(env, 'node', extra), runtime: 'node' }
    const python = (this.opts.platform ?? process.platform) === 'win32' ? 'python' : 'python3'
    return { command: python, args: [entry.file], cwd: c.folder!, env: botEnv(env, 'python', extra), runtime: 'python' }
  }

  /** Starts a bot; `invite` (a bot invite link) is used until the bot has joined, and never written to disk. */
  start(id: string, invite?: unknown): BotStatus | null {
    const c = this.configs.find((b) => b.id === id)
    if (!c) return null
    if (isInvite(invite)) this.invites.set(id, invite)
    if (this.running.has(id)) return this.status(c)
    const plan = this.plan(c)
    if ('error' in plan) {
      this.fail(c.id, plan.error)
      return this.status(c)
    }
    const dir = this.dataDir(c.id)
    mkdirSync(dir, { recursive: true })
    this.trimLogFile(dir)
    this.line(c.id, `── ${new Date().toISOString()} starting ${c.name}`)
    let child: ChildProcess
    try {
      child = this.opts.spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Elsewhere, its own process group, so stopping it also stops anything it started.
        detached: (this.opts.platform ?? process.platform) !== 'win32',
      })
    } catch (e) {
      this.fail(c.id, 'spawn', (e as Error).message)
      return this.status(c)
    }
    const run: Running = { child, stopping: false, partial: { out: '', err: '' } }
    this.running.set(id, run)
    this.states.set(id, { state: 'starting', online: false, problem: null })
    child.stdout?.on('data', (d: Buffer) => this.output(id, run, 'out', d))
    child.stderr?.on('data', (d: Buffer) => this.output(id, run, 'err', d))
    child.once('error', (e: NodeJS.ErrnoException) => {
      // The program couldn't be started at all (Python not installed, for one).
      if (this.running.get(id) !== run) return
      this.running.delete(id)
      this.fail(id, e.code === 'ENOENT' && plan.runtime === 'python' ? 'no-python' : 'spawn', e.message)
    })
    child.once('exit', (code, signal) => {
      if (this.running.get(id) !== run) return
      this.running.delete(id)
      for (const stream of ['out', 'err'] as const) if (run.partial[stream]) this.line(id, run.partial[stream])
      if (run.stopping) {
        this.states.set(id, { state: 'stopped', online: false, problem: null })
        this.line(id, '── stopped')
        this.opts.onEvent?.('stopped', id, null)
      } else {
        const exit = code ?? (signal ? -1 : 0)
        this.states.set(id, { state: exit === 0 ? 'stopped' : 'failed', online: false, problem: String(exit) })
        this.line(id, `── ended by itself (exit ${exit})`)
        this.opts.onEvent?.('exited', id, exit)
      }
      this.opts.onChange?.()
    })
    this.opts.onEvent?.('started', id, plan.runtime)
    this.opts.onChange?.()
    return this.status(c)
  }

  private fail(id: string, why: string, message?: string): void {
    this.states.set(id, { state: 'failed', online: false, problem: why })
    this.line(id, `── couldn't start (${why})${message ? `: ${message}` : ''}`)
    this.opts.onEvent?.('failed', id, why)
    this.opts.onChange?.()
  }

  private output(id: string, run: Running, stream: 'out' | 'err', data: Buffer): void {
    const text = run.partial[stream] + data.toString('utf8')
    const lines = text.split(/\r?\n/)
    run.partial[stream] = (lines.pop() ?? '').slice(-MAX_LINE * 4)
    for (const line of lines) {
      this.line(id, line)
      // The SDKs say "Online in "<server>" as <name>" once connected: the invite is used up, the bot is on.
      if (/Online in "/.test(line)) {
        this.invites.delete(id)
        const s = this.states.get(id)
        if (s && this.running.get(id) === run) {
          this.states.set(id, { ...s, state: 'running', online: true })
          this.opts.onChange?.()
        }
      } else if (/^\[[^\]]+\] (Disconnected|Rejected)/.test(line)) {
        const s = this.states.get(id)
        if (s?.online) {
          this.states.set(id, { ...s, online: false })
          this.opts.onChange?.()
        }
      }
    }
  }

  /** One line of a bot's output: kept in memory (the last 300) and in its bot.log. Colors and control characters go. */
  private line(id: string, raw: string): void {
    const clean = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, MAX_LINE)
    if (!clean.trim()) return
    const lines = this.logs.get(id) ?? []
    lines.push(clean)
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES)
    this.logs.set(id, lines)
    try {
      mkdirSync(this.dataDir(id), { recursive: true })
      appendFileSync(path.join(this.dataDir(id), 'bot.log'), clean + '\n')
    } catch {
      /* the in-memory lines still show */
    }
  }

  private trimLogFile(dir: string): void {
    const file = path.join(dir, 'bot.log')
    try {
      if (statSync(file).size > MAX_LOG_BYTES) {
        const text = readFileSync(file, 'utf8')
        writeFileSync(file, text.slice(-MAX_LOG_BYTES / 2))
      }
    } catch {
      /* no log yet */
    }
  }

  /** The last lines of a bot's output (from bot.log after a restart of the app). */
  tail(id: string, count = 200): string[] {
    let lines = this.logs.get(id)
    if (!lines) {
      try {
        lines = readFileSync(path.join(this.dataDir(id), 'bot.log'), 'utf8').split('\n').filter(Boolean).slice(-LOG_LINES)
      } catch {
        lines = []
      }
      this.logs.set(id, lines)
    }
    return lines.slice(-Math.max(1, Math.min(LOG_LINES, count)))
  }

  /** Stops a bot: SIGTERM (Windows: ends it and what it started), then SIGKILL after 3 seconds. Resolves once it's gone. */
  stop(id: string, kill: (child: ChildProcess, force: boolean) => void = defaultKill(this.opts.platform ?? process.platform)): Promise<BotStatus | null> {
    const run = this.running.get(id)
    const c = this.configs.find((b) => b.id === id)
    if (!run) return Promise.resolve(c ? this.status(c) : null)
    run.stopping = true
    const gone = new Promise<void>((resolve) => {
      if (run.child.exitCode !== null || run.child.signalCode !== null) return resolve()
      run.child.once('exit', () => resolve())
    })
    kill(run.child, false)
    const timer = setTimeout(() => kill(run.child, true), 3000)
    return gone.then(() => {
      clearTimeout(timer)
      return c ? this.status(c) : null
    })
  }

  /** Forgets a bot (stopping it first). A gallery bot's folder goes too, with its keys; a folder bot's own folder stays. */
  async remove(id: string): Promise<boolean> {
    const c = this.configs.find((b) => b.id === id)
    if (!c) return false
    await this.stop(id)
    this.configs = this.configs.filter((b) => b.id !== id)
    this.invites.delete(id)
    this.logs.delete(id)
    this.states.delete(id)
    this.save()
    rmSync(this.dataDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    this.opts.onChange?.()
    return true
  }

  /** The bots set to start with the app. */
  autostartIds(): string[] {
    return this.configs.filter((c) => c.autostart).map((c) => c.id)
  }

  anyRunning(): boolean {
    return this.running.size > 0
  }

  stopAll(): Promise<void> {
    return Promise.all([...this.running.keys()].map((id) => this.stop(id))).then(() => undefined)
  }
}

/** Windows: taskkill /T ends the bot and anything it started. Elsewhere: its process group, politely first. */
export function defaultKill(platform: NodeJS.Platform): (child: ChildProcess, force: boolean) => void {
  return (child, force) => {
    if (child.pid === undefined) return
    if (platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    }
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    }
  }
}
