// Hosting from the desktop app: each server is a world folder (Documents/Iskra/Servers; Application Support on macOS),
// run with the bundled iskra-server (and LiveKit for voice) while the app is open.
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { defaultHostRoot, exeName } from './platform'
import { text } from './i18n'
import { adjustRestoredSettings } from './restore'
import { tailscaleAddress, tailscaleUrl } from './tailscale'
import type { HostTunnels, P2pHostStatus } from './p2p/hostTunnel'

export interface HostedServer {
  id: string
  name: string
  folder: string
  port: number
  running: boolean
  /** How friends on the same network reach it. */
  lanUrl: string
  /** How this computer reaches it (never changes, unlike the LAN address). */
  localUrl: string
  /** How friends on Tailscale reach it (this computer's 100.x address), or null when Tailscale isn't on. */
  tailscaleUrl: string | null
  /** Single-use link that makes you the owner (only until you've used it). */
  ownerInvite: string | null
  /** "Keep my server running": starts with the computer (filled in by main.ts from the desktop settings). */
  keepRunning?: boolean
  /** The peer-to-peer tunnel for friends without port forwarding (Server settings → Internet access), when the world has it on. */
  p2p: P2pHostStatus | null
}

/** A starter template as `iskra-server templates --json` describes it (for the setup wizard's preview). */
export interface ServerTemplateInfo {
  id: string
  name: string
  description: string
  categories: { name: string; channels: { name: string; kind: string; userLimit: number }[] }[]
  channels: { name: string; kind: string; userLimit: number }[]
  roles: string[]
  rules: boolean
}

/** Built-in template ids only: the page never names a file. */
export const isTemplateId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v)

const exe = (name: string) => exeName(name, process.platform)

function serverBinary(): string | null {
  const candidates = [
    process.env.ISKRA_SERVER_EXE,
    app.isPackaged ? path.join(process.resourcesPath, 'server', exe('iskra-server')) : null,
    path.join(__dirname, '..', '..', 'server', 'src', 'Iskra.Server', 'bin', 'Debug', 'net10.0', exe('iskra-server')),
  ]
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null
}

function liveKitBinary(): string | null {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'server', exe('livekit-server')) : null,
    path.join(__dirname, '..', '..', '.tools', exe('livekit-server')),
  ]
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null
}

/** The first private IPv4 address, so friends on your Wi-Fi can connect. */
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family === 'IPv4' && !address.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address))
        return address.address
    }
  }
  return 'localhost'
}

/** Free means nothing answers on it and we can bind it the way the server will (0.0.0.0). */
async function portFree(port: number): Promise<boolean> {
  const answers = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
  if (answers) return false
  return new Promise((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .listen({ port, host: '0.0.0.0', exclusive: true }, () => probe.close(() => resolve(true)))
  })
}

async function pickPort(taken: Set<number>, start: number): Promise<number> {
  for (let port = start; port < start + 200; port++) if (!taken.has(port) && (await portFree(port))) return port
  throw new Error(text().host.noPort)
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server'
}

const POSIX = process.platform !== 'win32'

/** The server process ended while starting (most often: its port was taken just before it could bind it). */
class StoppedEarly extends Error {}

/** Force-stops a server and everything it started (LiveKit): taskkill /T on Windows, the process group elsewhere. */
function forceKill(child: ChildProcess): void {
  if (!POSIX) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-child.pid!, 'SIGKILL') // POSIX servers lead their own group
  } catch {
    child.kill('SIGKILL')
  }
}

/** How long a server gets to shut down cleanly (unmap router ports, stop LiveKit) before it's killed. */
export const GRACEFUL_STOP_MS = 5000

/**
 * Stops a server: closing its stdin asks it to shut down cleanly (ISKRA_STOP_ON_STDIN_CLOSE), and if it's
 * still around after a few seconds it's killed. Resolves once it's gone. `restart`: the app starts it again right
 * away (restarting into an update), so it tells members "restarting, hold on" instead of "offline".
 */
function stopServer(child: ChildProcess, restart = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve()
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (restart) child.stdin?.end('restart\n')
  else child.stdin?.end()
  const timer = setTimeout(() => forceKill(child), GRACEFUL_STOP_MS)
  return exited.finally(() => clearTimeout(timer))
}

export class Host {
  private readonly root =
    process.env.ISKRA_HOST_ROOT || defaultHostRoot(process.platform, { documents: app.getPath('documents'), userData: app.getPath('userData') })
  private readonly processes = new Map<string, ChildProcess>()

  /** `p2p`: the tunnels for worlds that let friends connect without port forwarding (none in tests without a testnet). */
  constructor(private readonly p2p?: HostTunnels) {}

  available(): boolean {
    return serverBinary() !== null
  }

  list(): HostedServer[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(this.root, d.name, 'server.json')))
      .map((d) => this.describe(d.name))
  }

  private describe(id: string): HostedServer {
    const folder = path.join(this.root, id)
    const settings = JSON.parse(readFileSync(path.join(folder, 'server.json'), 'utf8')) as { Name?: string; Port?: number; PublicUrl?: string; LocalOnly?: boolean }
    const invitePath = path.join(folder, 'owner-invite.txt')
    return {
      id,
      name: settings.Name ?? id,
      folder,
      port: settings.Port ?? 47070,
      running: this.processes.has(id),
      lanUrl: settings.PublicUrl ?? `http://${lanAddress()}:${settings.Port ?? 47070}`,
      localUrl: `http://localhost:${settings.Port ?? 47070}`,
      tailscaleUrl: tailscaleUrl(tailscaleAddress(networkInterfaces()), settings.Port ?? 47070, settings.LocalOnly === true),
      ownerInvite: existsSync(invitePath) ? readFileSync(invitePath, 'utf8').trim() : null,
      p2p: this.p2p?.status(id) ?? null,
    }
  }

  /** The owner switched "Let friends connect without port forwarding" (or rotated its key): follow the world's files. */
  async syncP2p(id: string): Promise<HostedServer> {
    if (this.processes.has(id)) await this.p2p?.sync(id, path.join(this.root, id))
    return this.describe(id)
  }

  private templateList: Promise<ServerTemplateInfo[]> | null = null

  /** The server's built-in starter templates, asked once (iskra-server templates --json; it opens no ports). */
  templates(): Promise<ServerTemplateInfo[]> {
    const binary = serverBinary()
    if (!binary) return Promise.resolve([])
    this.templateList ??= new Promise<ServerTemplateInfo[]>((resolve) => {
      const child = spawn(binary, ['templates', '--json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.once('error', () => resolve([]))
      child.once('exit', (code) => {
        try {
          const parsed = JSON.parse(out) as ServerTemplateInfo[]
          resolve(code === 0 && Array.isArray(parsed) ? parsed.filter((t) => isTemplateId(t?.id)) : [])
        } catch {
          resolve([])
        }
      })
    }).then((list) => {
      if (list.length === 0) this.templateList = null // try again next time
      return list
    })
    return this.templateList
  }

  async create(name: string, appUrl: string, template: string | null = null): Promise<HostedServer> {
    const clean = name.trim().slice(0, 60) || text().host.defaultName
    mkdirSync(this.root, { recursive: true })
    let id = slug(clean)
    for (let n = 2; existsSync(path.join(this.root, id)); n++) id = `${slug(clean)}-${n}`
    const folder = path.join(this.root, id)
    mkdirSync(folder, { recursive: true })

    const taken = new Set(this.list().flatMap((s) => [s.port]))
    // A port can be taken by another program between picking it and the server binding it; the server then stops
    // right away. Start over in a fresh folder on other ports a few times.
    for (let attempt = 1; ; attempt++) {
      const port = await pickPort(taken, 47070)
      const voicePort = await pickPort(new Set([...taken, port]), 7880)
      this.writeNewServer(folder, clean, port, voicePort, appUrl, template)
      try {
        await this.start(id)
        return this.describe(id)
      } catch (error) {
        if (!(error instanceof StoppedEarly) || attempt === 3) throw error
        taken.add(port).add(voicePort)
        rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        mkdirSync(folder, { recursive: true })
      }
    }
  }

  private writeNewServer(folder: string, clean: string, port: number, voicePort: number, appUrl: string, template: string | null): void {
    writeFileSync(
      path.join(folder, 'server.json'),
      JSON.stringify(
        {
          Name: clean,
          Port: port,
          // Applied once by the server on its first start (channels, voice rooms, roles, rules).
          ...(template && isTemplateId(template) ? { Template: template } : {}),
          AppUrl: appUrl,
          // Tests: localhost only, so Windows never asks about the firewall.
          ...(process.env.ISKRA_LOCAL_ONLY === '1'
            ? { LocalOnly: true, PublicUrl: `http://localhost:${port}` }
            : { PublicUrl: `http://${lanAddress()}:${port}` }),
          Voice: { Enabled: true, Port: voicePort, RtcTcpPort: voicePort + 1, RtcUdpPort: voicePort + 2 },
        },
        null,
        2,
      ),
    )
  }

  async start(id: string): Promise<HostedServer> {
    if (this.processes.has(id)) return this.describe(id)
    const binary = serverBinary()
    if (!binary) throw new Error(text().host.noServer)
    const folder = path.join(this.root, id)
    this.refreshLanAddress(folder)
    const livekit = liveKitBinary()
    // The server's output goes to server.log in its folder, handy when something's wrong.
    const log = openSync(path.join(folder, 'server.log'), 'a')
    const child = spawn(binary, [folder], {
      cwd: folder,
      // stdin stays open while we want the server running; closing it stops the server cleanly.
      stdio: ['pipe', log, log],
      windowsHide: true,
      // Elsewhere, its own process group so stopping it also stops LiveKit (Windows uses a job object).
      detached: POSIX,
      // ISKRA_PARENT_PID: the server shuts itself down if the app goes away, even after a crash.
      env: {
        ...process.env,
        ISKRA_PARENT_PID: String(process.pid),
        ISKRA_STOP_ON_STDIN_CLOSE: '1',
        // Updates come with the app, not from the server itself.
        Updates__ManagedBy: 'desktop',
        // The peer-to-peer tunnel runs here (HostTunnels), not in the server's own sidecar.
        ISKRA_P2P_TUNNEL: 'app',
        ...(livekit ? { ISKRA_LIVEKIT: livekit } : {}),
      },
    })
    child.stdin?.on('error', () => undefined) // the server may already be gone
    this.processes.set(id, child)
    let failure: Error | null = null
    const ended = (error: Error) => {
      if (failure) return
      failure = error
      if (this.processes.get(id) === child) this.processes.delete(id)
      closeSync(log)
    }
    // Exit code 3: the server can't open its files (WorldProblem in the server); its reason is in server.log.
    child.once('exit', (code) => ended(code === 3 ? new Error(text().host.damaged) : new StoppedEarly(text().host.stoppedEarly)))
    // e.g. the binary can't be executed (missing, or blocked by the OS).
    child.once('error', (error) => ended(new Error(text().host.couldntStart(error.message))))

    // Ready when it answers HTTP (and has written its owner invite on first run). It must be this server: if another
    // one got the port first, this one stops (and is reported) rather than the app joining a stranger's server.
    const { port } = this.describe(id)
    const name = (JSON.parse(readFileSync(path.join(folder, 'server.json'), 'utf8')) as { Name?: string }).Name
    for (let i = 0; i < 150; i++) {
      if (failure) throw failure
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`)
        const body = (await response.json().catch(() => null)) as { name?: string } | null
        if (response.ok && (name === undefined || body?.name === name) && !failure) break
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    // The tunnel listener's port is written once the server listens; the tunnel follows (and later changes, see syncP2p).
    if (!failure) void this.p2p?.sync(id, folder)
    return this.describe(id)
  }

  /** Home networks hand out new addresses now and then; keep invite links pointing at the current one. */
  private refreshLanAddress(folder: string): void {
    const file = path.join(folder, 'server.json')
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { PublicUrl?: string; Port?: number; LocalOnly?: boolean }
    if (settings.LocalOnly) return // nobody else can connect: its address stays localhost
    const current = `http://${lanAddress()}:${settings.Port ?? 47070}`
    if (settings.PublicUrl?.match(/^http:\/\/(10\.|192\.168\.|172\.|localhost)/) && settings.PublicUrl !== current) {
      writeFileSync(file, JSON.stringify({ ...settings, PublicUrl: current }, null, 2))
    }
  }

  async stop(id: string): Promise<HostedServer> {
    const child = this.processes.get(id)
    this.processes.delete(id)
    await this.p2p?.stop(id)
    if (child) await stopServer(child)
    return this.describe(id)
  }

  /**
   * Restores a backup into a new server folder (iskra-server restore, passphrase on stdin), gives it free ports and
   * this network's address, and starts it. Rejects with the server's own explanation (wrong passphrase, damaged file).
   */
  async restore(backupPath: string, passphrase: string, hint: string | null): Promise<{ server: HostedServer; serverKey: string; name: string }> {
    const binary = serverBinary()
    if (!binary) throw new Error(text().host.noServer)
    mkdirSync(this.root, { recursive: true })
    const base = slug(hint ?? path.basename(backupPath).replace(/\.(iskrabackup|zip)$/i, ''))
    let id = base
    for (let n = 2; existsSync(path.join(this.root, id)); n++) id = `${base}-${n}`
    const folder = path.join(this.root, id)

    const result = await new Promise<{ name: string; serverKey: string }>((resolve, reject) => {
      const child = spawn(binary, ['restore', backupPath, folder, '--passphrase-stdin', '--json'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.once('error', (e) => reject(new Error(text().host.couldntRun(e.message))))
      child.once('exit', (code) => {
        const line = out.trim().split(/\r?\n/).at(-1) ?? ''
        try {
          const parsed = JSON.parse(line) as { ok?: boolean; name?: string; serverKey?: string }
          if (code === 0 && parsed.ok && parsed.serverKey) return resolve({ name: parsed.name ?? id, serverKey: parsed.serverKey })
        } catch {
          /* not JSON: an error message */
        }
        const message = err.trim().split(/\r?\n/).filter(Boolean).at(-1)
        reject(new Error(message || text().host.restoreFailed))
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(`${passphrase}\n`)
    })

    // This computer's ports and address; everything else stays as it was.
    const file = path.join(folder, 'server.json')
    const settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const taken = new Set(this.list().filter((s) => s.id !== id).flatMap((s) => [s.port]))
    const port = await pickPort(taken, typeof settings.Port === 'number' ? settings.Port : 47070)
    const voicePort = await pickPort(new Set([...taken, port]), 7880)
    writeFileSync(file, JSON.stringify(adjustRestoredSettings(settings, { port, voicePort }, lanAddress(), process.env.ISKRA_LOCAL_ONLY === '1'), null, 2))
    const server = await this.start(id)
    return { server, serverKey: result.serverKey, name: result.name }
  }

  running(): boolean {
    return this.processes.size > 0
  }

  /** Stops every server; resolves when they've exited (a few seconds at most). `restart`: the app is restarting. */
  stopAll(restart = false): Promise<void> {
    const children = [...this.processes.values()]
    this.processes.clear()
    const done = Promise.all([...children.map((child) => stopServer(child, restart)), this.p2p?.stopAll()]).then(() => undefined)
    return Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_STOP_MS + 2000).unref())])
  }

  async startAll(ids: string[] = this.list().map((s) => s.id)): Promise<void> {
    await Promise.all(ids.map((id) => this.start(id).catch(() => undefined)))
  }
}
