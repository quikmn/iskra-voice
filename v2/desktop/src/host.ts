// Hosting from the desktop app: each server is a world folder under Documents/Iskra/Servers,
// run with the bundled iskra-server (and LiveKit for voice) while the app is open.
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import path from 'node:path'

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
  /** Single-use link that makes you the owner (only until you've used it). */
  ownerInvite: string | null
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

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
  throw new Error('No free port found.')
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server'
}

/** Stops a server and everything it started (LiveKit). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGTERM')
}

export class Host {
  private readonly root = process.env.ISKRA_HOST_ROOT || path.join(app.getPath('documents'), 'Iskra', 'Servers')
  private readonly processes = new Map<string, ChildProcess>()

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
    const settings = JSON.parse(readFileSync(path.join(folder, 'server.json'), 'utf8')) as { Name?: string; Port?: number; PublicUrl?: string }
    const invitePath = path.join(folder, 'owner-invite.txt')
    return {
      id,
      name: settings.Name ?? id,
      folder,
      port: settings.Port ?? 47070,
      running: this.processes.has(id),
      lanUrl: settings.PublicUrl ?? `http://${lanAddress()}:${settings.Port ?? 47070}`,
      localUrl: `http://localhost:${settings.Port ?? 47070}`,
      ownerInvite: existsSync(invitePath) ? readFileSync(invitePath, 'utf8').trim() : null,
    }
  }

  async create(name: string, appUrl: string): Promise<HostedServer> {
    const clean = name.trim().slice(0, 60) || 'My server'
    mkdirSync(this.root, { recursive: true })
    let id = slug(clean)
    for (let n = 2; existsSync(path.join(this.root, id)); n++) id = `${slug(clean)}-${n}`
    const folder = path.join(this.root, id)
    mkdirSync(folder, { recursive: true })

    const taken = new Set(this.list().flatMap((s) => [s.port]))
    const port = await pickPort(taken, 47070)
    const voicePort = await pickPort(new Set([...taken, port]), 7880)
    writeFileSync(
      path.join(folder, 'server.json'),
      JSON.stringify(
        {
          Name: clean,
          Port: port,
          PublicUrl: `http://${lanAddress()}:${port}`,
          AppUrl: appUrl,
          Voice: { Enabled: true, Port: voicePort, RtcTcpPort: voicePort + 1, RtcUdpPort: voicePort + 2 },
        },
        null,
        2,
      ),
    )
    await this.start(id)
    return this.describe(id)
  }

  async start(id: string): Promise<HostedServer> {
    if (this.processes.has(id)) return this.describe(id)
    const binary = serverBinary()
    if (!binary) throw new Error("This build doesn't include the server.")
    const folder = path.join(this.root, id)
    this.refreshLanAddress(folder)
    const livekit = liveKitBinary()
    // The server's output goes to server.log in its folder, handy when something's wrong.
    const log = openSync(path.join(folder, 'server.log'), 'a')
    const child = spawn(binary, [folder], {
      cwd: folder,
      stdio: ['ignore', log, log],
      windowsHide: true,
      // ISKRA_PARENT_PID: the server shuts itself down if the app goes away, even after a crash.
      env: { ...process.env, ISKRA_PARENT_PID: String(process.pid), ...(livekit ? { ISKRA_LIVEKIT: livekit } : {}) },
    })
    this.processes.set(id, child)
    child.once('exit', () => {
      this.processes.delete(id)
      closeSync(log)
    })

    // Ready when it answers HTTP (and has written its owner invite on first run).
    const { port } = this.describe(id)
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error('The server stopped right after starting. Is its port in use?')
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return this.describe(id)
  }

  /** Home networks hand out new addresses now and then; keep invite links pointing at the current one. */
  private refreshLanAddress(folder: string): void {
    const file = path.join(folder, 'server.json')
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { PublicUrl?: string; Port?: number }
    const current = `http://${lanAddress()}:${settings.Port ?? 47070}`
    if (settings.PublicUrl?.match(/^http:\/\/(10\.|192\.168\.|172\.|localhost)/) && settings.PublicUrl !== current) {
      writeFileSync(file, JSON.stringify({ ...settings, PublicUrl: current }, null, 2))
    }
  }

  stop(id: string): HostedServer {
    const child = this.processes.get(id)
    if (child) killTree(child)
    this.processes.delete(id)
    return this.describe(id)
  }

  stopAll(): void {
    for (const child of this.processes.values()) killTree(child)
    this.processes.clear()
  }

  async startAll(): Promise<void> {
    await Promise.all(this.list().map((s) => this.start(s.id).catch(() => undefined)))
  }
}
