// "Bots on this PC": the desktop app runs bots as child processes. Gallery bots ship with the app (dist/gallery, built
// from bots/gallery) and run with the app's own Node (ELECTRON_RUN_AS_NODE), so updates come with app updates and
// nothing is downloaded. A bot from a folder runs with the same Node (JavaScript or TypeScript) or the computer's own
// Python, after the person confirmed (in a native dialog) that they trust it. Bots run with the user's rights and only
// connect out to their server: nothing listens on a port.
// State lives in userData/bots (only the user can read it): bots.json (which bots, their settings, autostart; secret
// settings encrypted with the OS keychain when there is one) and a folder per bot (its keys and data for gallery bots,
// bot.log, and bot.pid while it runs). Invite links are kept in memory only, until the bot has joined. Bots never
// outlive the app: they're killed when it quits, and leftovers from a crash are killed before anything starts again.
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  /** Gallery bots: environment variables from their declared settings (secret ones never leave the main process). */
  settings: Record<string, string>
  /** Folder bots: the person confirmed they trust it (asked once, before its first run). */
  trusted?: boolean
}

export type BotState = 'stopped' | 'starting' | 'running' | 'failed'

export interface BotStatus extends Omit<BotConfig, 'trusted'> {
  state: BotState
  /** Connected to its server (it said "Online in …"). */
  online: boolean
  /** It hasn't joined a server yet (gallery bots without keys): starting needs a bot invite. */
  needsInvite: boolean
  /** Why the last run ended, when it ended by itself: an exit code, or no-entry / no-python / spawn / not-trusted. */
  problem: string | null
  /** Secret settings that have a value (their values stay in the main process). */
  secretsSet: string[]
}

export type LaunchPlan =
  | { command: string; args: string[]; cwd: string; env: Record<string, string>; runtime: 'node' | 'python' }
  | { error: 'no-entry' | 'no-python' }

export const MAX_BOTS = 20
export const LOG_LINES = 300
export const MAX_LOG_BYTES = 1024 * 1024
/** Lines per second a bot may write to its log; more are counted and skipped. */
export const LOG_LINES_PER_SECOND = 200
const MAX_LINE = 1000
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Bot invites the way the app makes them: an address with "#/join/". */
export const isInvite = (v: unknown): v is string => typeof v === 'string' && v.length <= 2000 && /^(https?|iskra):\/\/\S+#\/join\/\S+$/.test(v)

/** Environment variables a setting may never set: they'd change which programs or libraries run, or the bot's identity. */
export const DENIED_ENV = /^(PATH|PATHEXT|COMSPEC|HOME|USERPROFILE|NODE_\w*|NPM_\w*|PYTHON\w*|ELECTRON_\w*|LD_\w*|DYLD_\w*|ISKRA_\w*|BOT_NAME)$/

/** The gallery manifest (assets/gallery.json), checked: anything odd is left out. */
export function parseGallery(raw: unknown): GalleryBot[] {
  const list = (raw as { bots?: unknown })?.bots
  if (!Array.isArray(list)) return []
  return list.flatMap((b: Record<string, unknown>) => {
    if (typeof b?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(b.id) || typeof b.name !== 'string') return []
    const settings = (Array.isArray(b.settings) ? b.settings : []).flatMap((s: Record<string, unknown>) =>
      typeof s?.env === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(s.env) && !DENIED_ENV.test(s.env) && (s.kind === 'text' || s.kind === 'number' || s.kind === 'secret')
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

/**
 * New settings from the page, merged onto the current ones: only declared settings, short single-line text (numbers as
 * digits). A secret the page leaves out (or sends empty) keeps its stored value, since the page never sees it; `null`
 * clears it.
 */
export function cleanSettings(raw: unknown, declared: GallerySetting[], current: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  for (const s of declared) {
    const value = given[s.env]
    const kept = current[s.env]
    if (s.kind === 'secret') {
      if (value === null) continue
      if (typeof value === 'string' && value.trim() !== '') out[s.env] = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300)
      else if (kept !== undefined) out[s.env] = kept
      continue
    }
    if (typeof value !== 'string') {
      if (kept !== undefined && !(s.env in given)) out[s.env] = kept
      continue
    }
    const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300)
    if (s.kind === 'number' && text !== '' && !/^\d{1,6}$/.test(text)) {
      if (kept !== undefined) out[s.env] = kept
      continue
    }
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

/**
 * The computer's Python, as an absolute path (so a python.exe inside the bot's folder can never be picked):
 * Windows: the `py` launcher (`py -3`), else a `python.exe` on the PATH that isn't the Microsoft Store's stub
 * (WindowsApps); elsewhere `python3` on the PATH. Null when there's none.
 */
export function resolvePython(platform: NodeJS.Platform, where: (name: string) => string[]): { command: string; args: string[] } | null {
  const real = (p: string) => path.isAbsolute(p) && !/[\\/]WindowsApps[\\/]/i.test(p)
  if (platform === 'win32') {
    const py = where('py').find(real)
    if (py) return { command: py, args: ['-3'] }
    const python = where('python').find(real)
    return python ? { command: python, args: [] } : null
  }
  const python3 = where('python3').find(real)
  return python3 ? { command: python3, args: [] } : null
}

/** Where a program is on the PATH (`where` on Windows, `which -a` elsewhere), run from the app's own folder. */
export function defaultWhere(platform: NodeJS.Platform, cwd: string): (name: string) => string[] {
  return (name) => {
    const result = platform === 'win32'
      ? spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, cwd })
      : spawnSync('which', ['-a', name], { encoding: 'utf8', cwd })
    return result.status === 0 ? String(result.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
  }
}

/** The environment a bot gets: the app's, without what would change how Node runs it or who the bot is, plus its own settings. */
export function botEnv(base: NodeJS.ProcessEnv, runtime: 'node' | 'python', extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key === 'NODE_OPTIONS' || key.startsWith('ELECTRON_') || key === 'ISKRA_INVITE' || key === 'ISKRA_BOT_STATE') continue
    env[key] = value
  }
  if (runtime === 'node') env.ELECTRON_RUN_AS_NODE = '1'
  env.PYTHONUNBUFFERED = '1' // log lines as they happen
  env.FORCE_COLOR = '0'
  return { ...env, ...extra }
}

/** The line both SDKs print once connected: `[<name>] Online in "<server>" as <name> (<role>)`. */
export const ONLINE_LINE = /^\[[^\]\r\n]{1,64}\] Online in ".*" as .{1,64} \((guest|member|trusted)\)$/
const OFFLINE_LINE = /^\[[^\]\r\n]{1,64}\] (Disconnected; retrying|Rejected by the server)/

/** Encrypts secret settings at rest (Electron safeStorage); null where the OS has no keychain (they're then stored as-is). */
export interface SecretBox {
  encrypt(text: string): string | null
  decrypt(text: string): string | null
}

/** Asks the person (a native dialog in the main process). */
export type Confirm = (kind: 'trust-folder' | 'autostart-folder', bot: { name: string; folder: string }) => Promise<boolean>

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
  secrets?: SecretBox
  confirm?: Confirm
  /** Finds programs on the PATH (for Python). */
  where?: (name: string) => string[]
  /** A process's command line, or null if it's gone (for leftovers from a crash). */
  commandLine?: (pid: number) => string | null
  /** Ends a process and everything it started, at once (taskkill /T /F, or SIGKILL to its group). */
  killTree?: (pid: number) => void
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

interface LogBuffer {
  pending: string[]
  /** bot.log's size as far as we know. */
  bytes: number
  /** Lines this second, and how many were skipped. */
  second: number
  count: number
  skipped: number
}

const ENCRYPTED = 'enc:'

export class BotRunner {
  private configs: BotConfig[] = []
  private readonly running = new Map<string, Running>()
  private readonly states = new Map<string, { state: BotState; online: boolean; problem: string | null }>()
  private readonly logs = new Map<string, string[]>()
  private readonly logBuffers = new Map<string, LogBuffer>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Bot invites waiting to be used (memory only): passed as ISKRA_INVITE until the bot is online. */
  private readonly invites = new Map<string, string>()
  private readonly opts: RunnerOptions

  constructor(options: RunnerOptions) {
    this.opts = options
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { bots?: BotConfig[] }
      this.configs = (saved.bots ?? []).filter((b) => typeof b?.id === 'string' && /^[a-z0-9-]{1,60}$/.test(b.id))
      for (const c of this.configs) c.settings = this.openSecrets(c)
    } catch {
      /* none yet */
    }
  }

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform
  }

  private get file(): string {
    return path.join(this.opts.root, 'bots.json')
  }

  private secretKeys(c: BotConfig): Set<string> {
    return new Set((this.galleryBot(c.gallery)?.settings ?? []).filter((s) => s.kind === 'secret').map((s) => s.env))
  }

  private openSecrets(c: BotConfig): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(c.settings ?? {})) {
      if (typeof value !== 'string') continue
      if (value.startsWith(ENCRYPTED)) {
        const plain = this.opts.secrets?.decrypt(value.slice(ENCRYPTED.length)) ?? null
        if (plain !== null) out[key] = plain
      } else out[key] = value
    }
    return out
  }

  private sealSecrets(c: BotConfig): Record<string, string> {
    const secret = this.secretKeys(c)
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(c.settings)) {
      const sealed = secret.has(key) ? this.opts.secrets?.encrypt(value) ?? null : null
      out[key] = sealed !== null ? ENCRYPTED + sealed : value // no keychain: as-is, in a file only this user can read
    }
    return out
  }

  private ensureRoot(): void {
    mkdirSync(this.opts.root, { recursive: true, mode: DIR_MODE })
    if (this.platform !== 'win32') chmodSync(this.opts.root, DIR_MODE)
  }

  private save(): void {
    this.ensureRoot()
    const sealed = this.configs.map((c) => ({ ...c, settings: this.sealSecrets(c) }))
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ bots: sealed }, null, 2), { mode: FILE_MODE })
    renameSync(`${this.file}.tmp`, this.file)
  }

  /** A bot's own folder: its keys and data (gallery bots), bot.log and bot.pid. */
  dataDir(id: string): string {
    return path.join(this.opts.root, id)
  }

  private ensureDataDir(id: string): string {
    this.ensureRoot()
    const dir = this.dataDir(id)
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    return dir
  }

  galleryBot(id: string | undefined): GalleryBot | undefined {
    return this.opts.gallery.find((g) => g.id === id)
  }

  list(): BotStatus[] {
    return this.configs.map((c) => this.status(c))
  }

  /** What the page sees: never a secret's value, only whether it's set. */
  private status(c: BotConfig): BotStatus {
    const s = this.states.get(c.id) ?? { state: 'stopped' as BotState, online: false, problem: null }
    const secret = this.secretKeys(c)
    const settings: Record<string, string> = {}
    const secretsSet: string[] = []
    for (const [key, value] of Object.entries(c.settings)) {
      if (secret.has(key)) {
        if (value) secretsSet.push(key)
      } else settings[key] = value
    }
    const { trusted: _trusted, ...config } = c
    return { ...config, settings, secretsSet, ...s, needsInvite: this.needsInvite(c) }
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
      config = { id: this.newId(base), kind: 'folder', folder: source.folder, name: cleanName(name, path.basename(source.folder)), autostart: false, settings: {}, trusted: false }
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

  /** Changes a bot. Turning on autostart for a folder bot asks first (it would then run unattended at every start). */
  async update(id: string, patch: { name?: unknown; autostart?: unknown; settings?: unknown }): Promise<BotStatus | null> {
    const c = this.configs.find((b) => b.id === id)
    if (!c) return null
    if (patch.name !== undefined) c.name = cleanName(patch.name, c.name)
    if (typeof patch.autostart === 'boolean') {
      if (patch.autostart && !c.autostart && c.kind === 'folder') {
        const ok = (await this.opts.confirm?.('autostart-folder', { name: c.name, folder: c.folder! })) ?? false
        if (ok) {
          c.autostart = true
          c.trusted = true
        }
      } else c.autostart = patch.autostart
    }
    if (patch.settings !== undefined && c.kind === 'gallery') c.settings = cleanSettings(patch.settings, this.galleryBot(c.gallery)?.settings ?? [], c.settings)
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
    const python = resolvePython(this.platform, this.opts.where ?? defaultWhere(this.platform, path.dirname(this.opts.execPath)))
    if (!python) return { error: 'no-python' }
    return { command: python.command, args: [...python.args, entry.file], cwd: c.folder!, env: botEnv(env, 'python', extra), runtime: 'python' }
  }

  /**
   * Starts a bot; `invite` (a bot invite link) is used until the bot has joined, and never written to disk. A folder bot
   * runs only once the person confirmed they trust it.
   */
  async start(id: string, invite?: unknown): Promise<BotStatus | null> {
    const c = this.configs.find((b) => b.id === id)
    if (!c) return null
    if (isInvite(invite)) this.invites.set(id, invite)
    if (this.running.has(id)) return this.status(c)
    if (c.kind === 'folder' && !c.trusted) {
      const ok = (await this.opts.confirm?.('trust-folder', { name: c.name, folder: c.folder! })) ?? false
      if (!ok) {
        this.fail(c.id, 'not-trusted')
        return this.status(c)
      }
      c.trusted = true
      this.save()
    }
    if (this.running.has(id)) return this.status(c)
    const plan = this.plan(c)
    if ('error' in plan) {
      this.fail(c.id, plan.error)
      return this.status(c)
    }
    const dir = this.ensureDataDir(c.id)
    this.line(c.id, `── ${new Date().toISOString()} starting ${c.name}`)
    let child: ChildProcess
    try {
      child = this.opts.spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Elsewhere, its own process group, so stopping it also stops anything it started.
        detached: this.platform !== 'win32',
      })
    } catch (e) {
      this.fail(c.id, 'spawn', (e as Error).message)
      return this.status(c)
    }
    const run: Running = { child, stopping: false, partial: { out: '', err: '' } }
    this.running.set(id, run)
    this.states.set(id, { state: 'starting', online: false, problem: null })
    // What runs, so a leftover from a crash can be recognised (and killed) at the next start.
    if (child.pid !== undefined) {
      try {
        writeFileSync(path.join(dir, 'bot.pid'), JSON.stringify({ pid: child.pid, script: plan.args.at(-1) }), { mode: FILE_MODE })
      } catch {
        /* only for the crash cleanup */
      }
    }
    child.stdout?.on('data', (d: Buffer) => this.output(id, run, 'out', d))
    child.stderr?.on('data', (d: Buffer) => this.output(id, run, 'err', d))
    child.once('error', (e: NodeJS.ErrnoException) => {
      // The program couldn't be started at all.
      if (this.running.get(id) !== run) return
      this.running.delete(id)
      this.dropPid(id)
      this.fail(id, e.code === 'ENOENT' && plan.runtime === 'python' ? 'no-python' : 'spawn', e.message)
    })
    child.once('exit', (code, signal) => {
      if (this.running.get(id) !== run) return
      this.running.delete(id)
      this.dropPid(id)
      for (const stream of ['out', 'err'] as const) if (run.partial[stream]) this.line(id, run.partial[stream])
      if (run.stopping) {
        this.states.set(id, { state: 'stopped', online: false, problem: null })
        this.line(id, '── stopped')
        this.opts.onEvent?.('stopped', id, null)
      } else {
        const exit = code ?? (signal ? -1 : 0)
        // 9009: Windows couldn't find the program (the Store's python stub says so too).
        const problem = plan.runtime === 'python' && exit === 9009 ? 'no-python' : String(exit)
        this.states.set(id, { state: exit === 0 ? 'stopped' : 'failed', online: false, problem })
        this.line(id, `── ended by itself (exit ${exit})`)
        this.opts.onEvent?.('exited', id, exit)
      }
      this.flush()
      this.opts.onChange?.()
    })
    this.opts.onEvent?.('started', id, plan.runtime)
    this.opts.onChange?.()
    return this.status(c)
  }

  private dropPid(id: string): void {
    rmSync(path.join(this.dataDir(id), 'bot.pid'), { force: true })
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
      // Both SDKs print this exact line once connected: the invite is used up, the bot is on.
      if (ONLINE_LINE.test(line)) {
        this.invites.delete(id)
        const s = this.states.get(id)
        if (s && this.running.get(id) === run) {
          this.states.set(id, { ...s, state: 'running', online: true })
          this.opts.onChange?.()
        }
      } else if (OFFLINE_LINE.test(line)) {
        const s = this.states.get(id)
        if (s?.online) {
          this.states.set(id, { ...s, online: false })
          this.opts.onChange?.()
        }
      }
    }
  }

  /**
   * One line of a bot's output: kept in memory (the last 300) and in its bot.log, written in batches. At most 200 lines
   * a second (more are counted as skipped), and bot.log is cut back to half when it passes 1 MB. Colors and control
   * characters go.
   */
  private line(id: string, raw: string, now = Date.now()): void {
    const clean = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, MAX_LINE)
    if (!clean.trim()) return
    const buffer = this.buffer(id)
    const second = Math.floor(now / 1000)
    if (second !== buffer.second) {
      if (buffer.skipped > 0) this.keep(id, buffer, `── ${buffer.skipped} lines skipped (too many at once)`)
      buffer.second = second
      buffer.count = 0
      buffer.skipped = 0
    }
    if (++buffer.count > LOG_LINES_PER_SECOND) {
      buffer.skipped++
      return
    }
    this.keep(id, buffer, clean)
  }

  private keep(id: string, buffer: LogBuffer, line: string): void {
    const lines = this.logs.get(id) ?? []
    lines.push(line)
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES)
    this.logs.set(id, lines)
    buffer.pending.push(line)
    this.flushTimer ??= setTimeout(() => this.flush(), 500)
    this.flushTimer.unref?.()
  }

  private buffer(id: string): LogBuffer {
    let buffer = this.logBuffers.get(id)
    if (!buffer) {
      let bytes = 0
      try {
        bytes = statSync(path.join(this.dataDir(id), 'bot.log')).size
      } catch {
        /* no log yet */
      }
      buffer = { pending: [], bytes, second: 0, count: 0, skipped: 0 }
      this.logBuffers.set(id, buffer)
    }
    return buffer
  }

  /** Writes the waiting log lines (every half second, and when a bot ends). */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const [id, buffer] of this.logBuffers) {
      if (buffer.pending.length === 0) continue
      const text = buffer.pending.join('\n') + '\n'
      buffer.pending = []
      if (!this.configs.some((c) => c.id === id)) continue // removed meanwhile
      try {
        const file = path.join(this.ensureDataDir(id), 'bot.log')
        appendFileSync(file, text, { mode: FILE_MODE })
        buffer.bytes += Buffer.byteLength(text)
        if (buffer.bytes > MAX_LOG_BYTES) {
          const kept = readFileSync(file, 'utf8').slice(-MAX_LOG_BYTES / 2)
          writeFileSync(file, kept.slice(kept.indexOf('\n') + 1), { mode: FILE_MODE })
          buffer.bytes = statSync(file).size
        }
      } catch {
        /* the in-memory lines still show */
      }
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
  stop(id: string, kill: (child: ChildProcess, force: boolean) => void = defaultKill(this.platform)): Promise<BotStatus | null> {
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

  /**
   * The app is quitting: ends every bot and what it started right now, synchronously (no timers that could die with
   * the app), and writes their logs.
   */
  killAll(): void {
    const killTree = this.opts.killTree ?? defaultKillTree(this.platform)
    for (const [id, run] of this.running) {
      run.stopping = true
      if (run.child.pid !== undefined) killTree(run.child.pid)
      this.dropPid(id)
    }
    this.flush()
  }

  /**
   * Bots left running by a crash of the app: each bot.pid whose process still runs the same script is killed (with what
   * it started) before anything starts again, so autostart never runs a bot twice. Returns how many were killed.
   */
  killLeftovers(): number {
    const commandLine = this.opts.commandLine ?? defaultCommandLine(this.platform)
    const killTree = this.opts.killTree ?? defaultKillTree(this.platform)
    let killed = 0
    for (const c of this.configs) {
      if (this.running.has(c.id)) continue
      const file = path.join(this.dataDir(c.id), 'bot.pid')
      let saved: { pid?: unknown; script?: unknown }
      try {
        saved = JSON.parse(readFileSync(file, 'utf8')) as typeof saved
      } catch {
        continue
      }
      rmSync(file, { force: true })
      if (typeof saved.pid !== 'number' || !Number.isInteger(saved.pid) || saved.pid <= 1 || typeof saved.script !== 'string') continue
      const command = commandLine(saved.pid)
      // Only if it's still that bot: a PID can be reused by an unrelated program.
      if (command && command.includes(saved.script)) {
        killTree(saved.pid)
        killed++
      }
    }
    return killed
  }

  /** Forgets a bot (stopping it first). A gallery bot's folder goes too, with its keys; a folder bot's own folder stays. */
  async remove(id: string): Promise<boolean> {
    const c = this.configs.find((b) => b.id === id)
    if (!c) return false
    await this.stop(id)
    this.flush()
    this.configs = this.configs.filter((b) => b.id !== id)
    this.invites.delete(id)
    this.logs.delete(id)
    this.logBuffers.delete(id)
    this.states.delete(id)
    this.save()
    rmSync(this.dataDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    this.opts.onChange?.()
    return true
  }

  /** The bots set to start with the app. */
  autostartIds(): string[] {
    return this.configs.filter((c) => c.autostart && (c.kind === 'gallery' || c.trusted)).map((c) => c.id)
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

/** Ends a process and everything it started, synchronously. */
export function defaultKillTree(platform: NodeJS.Platform): (pid: number) => void {
  return (pid) => {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      return
    }
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL') // its group first (bots lead their own), then the process itself
      } catch {
        /* already gone */
      }
    }
  }
}

/** A process's command line: /proc on Linux, ps on macOS, CIM on Windows. Null when it's not running. */
export function defaultCommandLine(platform: NodeJS.Platform): (pid: number) => string | null {
  return (pid) => {
    try {
      if (platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null
      const result = platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
        : spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 })
      const text = String(result.stdout ?? '').trim()
      return result.status === 0 && text ? text : null
    } catch {
      return null
    }
  }
}
