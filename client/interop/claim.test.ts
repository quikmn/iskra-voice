// "Claim a server" end to end: a server with "OwnerClaim": "generate" (the DigitalOcean Marketplace image), claimed the
// way the app does it (state/claimServer.ts), then joined as its owner, with a voice token and a LiveKit room.
//   npm run test:interop                       a local server (LocalOnly) makes the code; voice if .tools has LiveKit
//   ISKRA_DROPLET_URL=https://203-0-113-7.sslip.io ISKRA_DROPLET_CODE=... \
//     npx vitest run --config vitest.interop.config.ts interop/claim.test.ts
//                                              a real droplet (marketplace/digitalocean/test.sh); voice is required
// Never prints the claim code or anything derived from it.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadRtc } from '../../bots/sdk/src/voice/modules'
import { Connection } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import type { Events, Welcome } from '../src/core/protocol'
import { claimAddress, ClaimFailed, claimServer } from '../src/state/claimServer'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const LIVEKIT = process.env.ISKRA_LIVEKIT ?? resolve(__dirname, '../../.tools', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')
const DROPLET = process.env.ISKRA_DROPLET_URL

const freePort = () => new Promise<number>((done) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const port = (probe.address() as { port: number }).port
    probe.close(() => done(port))
  })
})

async function waitFor<T>(check: () => T | undefined | null | false, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** A well-formed code that isn't this server's (a wrong code must be refused by the proof check). */
const otherCode = (code: string) => (code.startsWith('0') ? '1' : '0') + code.slice(1)

interface Target {
  address: string
  code: string
  voice: boolean
  stop: () => Promise<void>
}

/** A local server like the droplet's: OwnerClaim "generate", the gaming template, voice when LiveKit is there. */
async function localServer(): Promise<Target> {
  const world = mkdtempSync(join(tmpdir(), 'iskra-claim-'))
  const port = await freePort()
  const voice = existsSync(LIVEKIT)
  writeFileSync(join(world, 'server.json'), JSON.stringify({
    Name: 'Claim me', Port: port, LocalOnly: true, Template: 'gaming', OwnerClaim: 'generate',
    Voice: voice
      ? { Enabled: true, Port: await freePort(), RtcTcpPort: await freePort(), RtcUdpPort: 40000 + Math.floor(Math.random() * 20000), LiveKitPath: LIVEKIT }
      : { Enabled: false },
  }))
  const proc = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore' })
  const stop = async () => {
    if (proc.exitCode === null) await new Promise<void>((done) => {
      proc.once('exit', () => done())
      proc.kill()
    })
    rmSync(world, { recursive: true, force: true })
  }
  try {
    // The same file the droplet's claim screen reads: code=, expires=, address=.
    const file = join(world, 'owner-claim-code.txt')
    const text = await waitFor(() => existsSync(file) && readFileSync(file, 'utf8'), 'owner-claim-code.txt', 30_000)
    const field = (name: string) => new RegExp(`^${name}=(.+)$`, 'm').exec(text)?.[1]?.trim() ?? ''
    expect(field('code')).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
    expect(Date.parse(field('expires')) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000)
    for (let i = 0; !(await fetch(`http://localhost:${port}/health`).catch(() => null))?.ok; i++) {
      if (i > 300) throw new Error('Server did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
    return { address: field('address'), code: field('code'), voice, stop }
  } catch (e) {
    await stop()
    throw e
  }
}

describe(DROPLET ? 'claiming the droplet' : 'claiming a generated code (local server)', () => {
  let target: Target
  let owner: Connection | null = null
  let welcome: Welcome | null = null
  const events: { type: keyof Events; body: unknown }[] = []

  beforeAll(async () => {
    await ready()
    if (DROPLET) {
      const code = process.env.ISKRA_DROPLET_CODE ?? ''
      target = { address: DROPLET, code, voice: true, stop: async () => undefined }
    } else {
      target = await localServer()
    }
  }, 120_000)

  afterAll(async () => {
    owner?.stop()
    await target?.stop()
  })

  it('a wrong code is refused, the right one gives an owner invite for this server', async () => {
    expect(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(target.code), 'not a claim code').toBe(true)
    const address = claimAddress(target.address)
    expect(address).toBe(target.address)
    const health = (await (await fetch(`${address}/health`)).json()) as { iskra?: number; status?: string; version?: string }
    expect(health).toMatchObject({ iskra: 1, status: 'ok' })
    console.log(`Server ${health.version} at ${address}`)

    const wrong = await claimServer(address!, otherCode(target.code)).then(() => null, (e: unknown) => e)
    expect(wrong).toBeInstanceOf(ClaimFailed)
    expect((wrong as ClaimFailed).reason).toBe('wrongCode')

    // Lower case and without dashes, as someone might type it.
    const invite = await claimServer(address!, target.code.replaceAll('-', '').toLowerCase())
    expect(invite.serverUrl).toBe(address)

    owner = new Connection({
      serverUrl: invite.serverUrl, expectedServerKey: invite.serverKey, invite: invite.code, identity: createIdentity(),
      name: () => 'Image test', onStatus: () => undefined, onWelcome: (w) => (welcome = w),
      onEvent: (type, body) => events.push({ type, body }),
    })
    owner.start()
    await waitFor(() => welcome, 'joining as the owner', 30_000)
    expect(welcome!.you.role).toBe('owner')
    expect(welcome!.server.key).toBe(invite.serverKey)
    expect(welcome!.channels.some((c) => c.kind === 'voice')).toBe(true) // the gaming template

    // Single use: once there's an owner, the server has no claim to prove any more.
    const again = await claimServer(address!, target.code).then(() => null, (e: unknown) => e)
    expect((again as ClaimFailed | null)?.reason).toBe('noClaim')
  }, 60_000)

  it('the owner gets a voice token and joins the LiveKit room', async (context) => {
    if (!target.voice) context.skip()
    expect(welcome, 'not joined').not.toBeNull()
    await waitFor(() => welcome!.voiceAvailable || events.some((e) => e.type === 'voice.available' && (e.body as Events['voice.available']).available),
      'voice available', 60_000)
    const channel = welcome!.channels.find((c) => c.kind === 'voice')!
    const { url, token } = await owner!.request('voice.join', { channelId: channel.id })
    expect(token.length).toBeGreaterThan(20)
    console.log(`Voice: ${url}`)

    // LiveKit's own SDK, as an app or a voice bot connects (on the droplet: through ufw, 443 and 7881/7882).
    const rtc = await loadRtc()
    const room = new rtc.Room()
    try {
      await room.connect(url, token, { autoSubscribe: false, dynacast: false })
      expect(room.isConnected).toBe(true)
    } finally {
      await room.disconnect()
    }
  }, 90_000)
})
