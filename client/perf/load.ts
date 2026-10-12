// Server load test: N clients (the app's own Connection, like the bot SDK) on a fresh local world: joins, chat,
// typing, presence, history, uploads, then a reconnect storm. Prints latencies and the server's CPU and memory.
//   cd bots && npm ci && node build.mjs ../client/perf/load.ts && node dist/load.js [clients] [steadySeconds]
// The server listens on localhost only (LocalOnly). Set ISKRA_PERF_COUNTERS to a dotnet-counters exe for GC/lock stats.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Connection } from '../src/core/connection'
import { b64u, randomBytes, ready, signingKeyPairFromSeed } from '../src/core/crypto'
import { certifyDevice, type Identity } from '../src/core/identity'
import { parseInvite } from '../src/core/invite'
import type { Events, Welcome } from '../src/core/protocol'

const CLIENTS = Number(process.argv[2] ?? 200)
const STEADY_S = Number(process.argv[3] ?? 60)
const HERE = dirname(fileURLToPath(import.meta.url))
const DLL = resolve(HERE, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const DLL_RELEASE = resolve(HERE, '../../server/src/Iskra.Server/bin/Release/net10.0/iskra-server.dll')

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => done(port))
    })
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN)
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 0.5).toFixed(1)} p95=${pct(xs, 0.95).toFixed(1)} p99=${pct(xs, 0.99).toFixed(1)} max=${pct(xs, 1).toFixed(1)} ms`

function newIdentity(): Identity {
  const account = signingKeyPairFromSeed(randomBytes(32))
  const device = signingKeyPairFromSeed(randomBytes(32))
  return { account, device, cert: certifyDevice(account, device.publicKey, Date.now()) }
}

/** CPU seconds and memory of the server process (Windows: PowerShell; elsewhere: ps). */
function sample(pid: number): { cpu: number; ws: number; priv: number } {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; "$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64) $($p.PrivateMemorySize64)"`]).toString().trim()
    const [cpu, ws, priv] = out.split(/\s+/).map(Number)
    return { cpu, ws, priv }
  }
  const [cpuTime, rss] = execFileSync('ps', ['-o', 'times=,rss=', '-p', String(pid)]).toString().trim().split(/\s+/)
  return { cpu: Number(cpuTime), ws: Number(rss) * 1024, priv: Number(rss) * 1024 }
}

interface Client {
  i: number
  conn: Connection
  welcomed: () => Promise<Welcome>
  onEvent: (cb: <K extends keyof Events>(type: K, body: Events[K]) => void) => void
}

async function main() {
  await ready()
  const world = mkdtempSync(join(tmpdir(), 'iskra-load-'))
  const port = await freePort()
  writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Load', Port: port, LocalOnly: true, Voice: { Enabled: false } }))
  const dll = existsSync(DLL_RELEASE) && process.env.ISKRA_PERF_RELEASE ? DLL_RELEASE : DLL
  const server = spawn('dotnet', [dll, world], { stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, Logging__LogLevel__Default: 'Warning' } })
  const url = `http://localhost:${port}`
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {
      /* starting */
    }
    if (i > 300) throw new Error('server did not start')
    await sleep(100)
  }
  const pid = server.pid!
  let counters: ReturnType<typeof spawn> | null = null
  const countersFile = join(tmpdir(), `iskra-load-counters-${pid}.csv`)
  if (process.env.ISKRA_PERF_COUNTERS) {
    counters = spawn(process.env.ISKRA_PERF_COUNTERS, ['collect', '-p', String(pid), '--refresh-interval', '2', '--format', 'csv', '-o', countersFile,
      '--counters', 'System.Runtime[dotnet.gc.heap.total_allocated,dotnet.gc.last_collection.heap.size,dotnet.monitor.lock_contentions,dotnet.thread_pool.queue.length,dotnet.thread_pool.thread.count,dotnet.process.cpu.time,dotnet.gc.collections]'], { stdio: 'ignore' })
  }

  const ownerLink = readFileSync(join(world, 'owner-invite.txt'), 'utf8').trim()
  const owner = parseInvite(ownerLink)!

  const lat: Record<string, number[]> = {}
  const record = (k: string, ms: number) => (lat[k] ??= []).push(ms)
  const timed = async <T,>(k: string, f: () => Promise<T>): Promise<T | null> => {
    const t = performance.now()
    try {
      const r = await f()
      record(k, performance.now() - t)
      return r
    } catch (e) {
      record(`${k} ERR ${(e as { code?: string }).code ?? (e as Error).message}`, performance.now() - t)
      return null
    }
  }

  const make = (i: number, invite: string | undefined): Client => {
    let welcome: ((w: Welcome) => void) | null = null
    let welcomed = new Promise<Welcome>((r) => (welcome = r))
    const listeners: ((type: keyof Events, body: unknown) => void)[] = []
    const identity = newIdentity()
    const conn = new Connection({
      serverUrl: owner.serverUrl,
      expectedServerKey: owner.serverKey,
      invite,
      identity,
      name: () => `load${i}`,
      onStatus: () => undefined,
      onWelcome: (w) => welcome?.(w),
      onEvent: (type, body) => {
        for (const l of listeners) l(type, body)
      },
      requestTimeoutMs: 60_000,
    })
    return {
      i,
      conn,
      welcomed: () => welcomed,
      onEvent: (cb) => listeners.push(cb as never),
      // re-arm on reconnect
      ...{ rearm: () => (welcomed = new Promise<Welcome>((r) => (welcome = r))) },
    } as Client & { rearm: () => void }
  }

  const phases: string[] = []
  let mark = { t: performance.now(), ...sample(pid) }
  const phase = (name: string) => {
    const now = { t: performance.now(), ...sample(pid) }
    const wall = (now.t - mark.t) / 1000
    phases.push(`${name.padEnd(18)} ${wall.toFixed(1).padStart(6)} s  cpu ${(((now.cpu - mark.cpu) / wall) * 100).toFixed(0).padStart(4)}% of one core  ws ${(now.ws / 2 ** 20).toFixed(0)} MB  private ${(now.priv / 2 ** 20).toFixed(0)} MB`)
    mark = now
  }
  phase('idle start')

  // Owner first, then an invite for everyone else.
  const first = make(0, owner.code)
  first.conn.start()
  const w0 = await first.welcomed()
  const general = w0.channels.find((c) => c.name === 'general')!.id
  const { invite } = await first.conn.request('invite.create', { maxUses: 100000 })
  const clients: (Client & { rearm: () => void })[] = [first as Client & { rearm: () => void }]
  const joinStart = performance.now()
  for (let i = 1; i < CLIENTS; i += 20) {
    const batch = Array.from({ length: Math.min(20, CLIENTS - i) }, (_, k) => make(i + k, invite.code) as Client & { rearm: () => void })
    await Promise.all(batch.map(async (c) => {
      const t = performance.now()
      c.conn.start()
      await c.welcomed()
      record('join (new member)', performance.now() - t)
    }))
    clients.push(...batch)
  }
  console.log(`joined ${clients.length} in ${((performance.now() - joinStart) / 1000).toFixed(1)} s`)
  phase(`join ${CLIENTS}`)

  // Fan-out: when a chat.message reaches 20 watching clients, how long after it was sent.
  let delivered = 0
  for (const c of clients.slice(0, 20)) {
    c.onEvent((type, body) => {
      if (type !== 'chat.message') return
      const text = (body as Events['chat.message']).message.text
      const m = /^t:(\d+\.?\d*)/.exec(text)
      if (m) record('fan-out delivery', performance.timeOrigin + performance.now() - Number(m[1]))
    })
  }
  let frames = 0
  for (const c of clients) c.onEvent(() => void frames++)

  // Steady chat: everyone sends every ~5 s, types every ~4 s, sets presence every ~20 s, reads history every ~30 s.
  let running = true
  const loops = clients.map(async (c) => {
    await sleep(Math.random() * 5000)
    let n = 0
    while (running) {
      n++
      void timed('chat.typing', () => c.conn.request('chat.typing', { channelId: general }))
      await sleep(400 + Math.random() * 400)
      await timed('chat.send', () => c.conn.request('chat.send', { channelId: general, text: `t:${performance.timeOrigin + performance.now()} hello from ${c.i} #${n}` }))
      if (n % 4 === 0) void timed('presence.set', () => c.conn.request('presence.set', { status: n % 8 ? 'online' : 'idle', custom: null, updatedAt: Date.now() } as never))
      if (n % 6 === 0) void timed('chat.history', () => c.conn.request('chat.history', { channelId: general, limit: 50 }))
      await sleep(4000 + Math.random() * 2000)
    }
  })
  await sleep(STEADY_S * 1000)
  running = false
  await Promise.all(loops)
  await sleep(1000)
  delivered = frames
  console.log(`frames received by clients during steady: ${delivered} (${(delivered / STEADY_S).toFixed(0)}/s)`)
  phase(`steady ${STEADY_S}s`)

  // Uploads: 50 people send a 1 MB file at once.
  const blob = randomBytes(1024 * 1024)
  await Promise.all(clients.slice(0, 50).map(async (c, k) => {
    const t = performance.now()
    const begin = await timed('upload.begin', () => c.conn.request('upload.begin', { name: `f${k}.bin`, size: blob.length }))
    if (!begin) return
    const r = await fetch(new URL(begin.url, url), { method: 'PUT', body: blob })
    const { file } = (await r.json()) as { file: { id: string } }
    await timed('chat.send (attachment)', () => c.conn.request('chat.send', { channelId: general, text: 'file', attachments: [file.id] }))
    record('upload 1 MB end to end', performance.now() - t)
  }))
  phase('uploads 50x1MB')

  // Reconnect storm: everyone drops and comes back within ~2 s.
  const stormStart = performance.now()
  await Promise.all(clients.map(async (c) => {
    c.conn.stop()
    c.rearm()
    await sleep(Math.random() * 2000)
    const t = performance.now()
    c.conn.start()
    await c.welcomed()
    record('storm reconnect', performance.now() - t)
  }))
  console.log(`storm: all ${clients.length} back in ${((performance.now() - stormStart) / 1000).toFixed(1)} s`)
  phase('reconnect storm')
  await sleep(5000)
  phase('idle after')

  for (const c of clients) c.conn.stop()
  counters?.kill()
  server.kill()
  await sleep(1500)
  console.log('\nLatencies (client-measured, request to reply):')
  for (const [k, xs] of Object.entries(lat)) console.log(`  ${k.padEnd(26)} ${fmt(xs)}`)
  console.log('\nServer process:')
  for (const p of phases) console.log('  ' + p)
  if (counters && existsSync(countersFile)) console.log(`\ncounters: ${countersFile}`)
  rmSync(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  process.exit(0)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
