// Friends without port forwarding, in the real desktop app: the host creates a server and turns on "Let friends
// connect without port forwarding"; a friend (a second desktop app) gets an invite whose address can't be reached
// and joins through the peer-to-peer tunnel instead: chat both ways, then voice relay-only through the tunnel.
// Everything on this machine binds 127.0.0.1: a private HyperDHT testnet stands in for the public one
// (ISKRA_P2P_BOOTSTRAP), the servers are localhost only (ISKRA_LOCAL_ONLY=1), nothing on the network is touched.
import dgram from 'node:dgram'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { SignalResponse } from '@livekit/protocol'
import { appWindow, agreeToTerms, hasLiveKit, SHOTS } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')
test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

type Testnet = { bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }
const createTestnet = createRequire(join(DESKTOP, 'package.json'))('hyperdht/testnet.js') as (size: number, opts: { host: string }) => Promise<Testnet>

const b64u = (text: string) => Buffer.from(text, 'utf8').toString('base64url')
const electronExe = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

/** Whether a STUN/TURN server answers a Binding request on 127.0.0.1:<port> (LiveKit's TURN does), for diagnostics. */
function stunAnswers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const sock = dgram.createSocket('udp4')
    const request = Buffer.alloc(20)
    request[1] = 0x01
    request.writeUInt32BE(0x2112a442, 4)
    const timer = setTimeout(() => { sock.close(); done(false) }, 2000)
    sock.on('message', (m) => { clearTimeout(timer); sock.close(); done(m.length >= 20 && m[0] === 0x01 && m[1] === 0x01) })
    sock.on('error', () => { clearTimeout(timer); sock.close(); done(false) })
    sock.bind(0, '127.0.0.1', () => sock.send(request, port, '127.0.0.1'))
  })
}

/** What each RTCPeerConnection was made with, and the connections themselves (for getStats). The page is already loaded (the app never navigates), so the hook goes in now; LiveKit only creates connections when voice starts. */
async function recordPeerConnections(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Original = window.RTCPeerConnection
    const configs: unknown[] = []
    const pcs: RTCPeerConnection[] = []
    const w = window as unknown as { __peerConfigs: unknown[]; __pcs: RTCPeerConnection[]; __signal: string[] }
    w.__peerConfigs = configs
    w.__pcs = pcs
    w.__signal = []
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        configs.push(JSON.parse(JSON.stringify(config ?? {})))
        super(config)
        pcs.push(this)
      }
    } as typeof RTCPeerConnection
    // The first frame of each LiveKit signalling socket (the join answer), base64, to see what LiveKit offered.
    const OriginalSocket = window.WebSocket
    window.WebSocket = class extends OriginalSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (String(url).includes('/livekit/rtc/')) {
          let first = true
          this.addEventListener('message', (e: MessageEvent) => {
            if (!first) return
            first = false
            const data = e.data as ArrayBuffer | Blob | string
            if (data instanceof ArrayBuffer) w.__signal.push(btoa(String.fromCharCode(...new Uint8Array(data))))
            else if (data instanceof Blob) void data.arrayBuffer().then((b) => w.__signal.push(btoa(String.fromCharCode(...new Uint8Array(b)))))
            else w.__signal.push(`text:${String(data).slice(0, 200)}`)
          })
        }
      }
    } as typeof WebSocket
  })
}

test('a friend joins a home-hosted server through the peer-to-peer tunnel and talks in voice', async () => {
  test.setTimeout(300_000)
  const testnet = await createTestnet(3, { host: '127.0.0.1' })
  const hostData = mkdtempSync(join(tmpdir(), 'iskra-p2p-host-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-p2p-hosted-'))
  const friendData = mkdtempSync(join(tmpdir(), 'iskra-p2p-friend-'))
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const env = { ...base, ISKRA_LOCAL_ONLY: '1', ISKRA_P2P_BIND: '127.0.0.1', ISKRA_P2P_BOOTSTRAP: `127.0.0.1:${testnet.bootstrap[0].port}` }
  const media = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  const launch = (userData: string, extra: Record<string, string> = {}) =>
    electron.launch({ executablePath: electronExe, args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', ...media], cwd: DESKTOP, env: { ...env, ISKRA_E2E: '1', ...extra } })
  const timings: [string, number][] = []
  let last = Date.now()
  const lap = (what: string) => {
    timings.push([what, Date.now() - last])
    last = Date.now()
  }

  let hostApp: ElectronApplication | null = null
  let friendApp: ElectronApplication | null = null
  const friendConsole: string[] = []
  let friendPage: Page | null = null
  let passed = false
  try {
    // ── The host: a fresh desktop app, a new server, the switch on ──
    hostApp = await launch(hostData, { ISKRA_HOST_ROOT: hostRoot })
    const host = await appWindow(hostApp)
    await agreeToTerms(host)
    await host.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await host.getByLabel('Your name').fill('Ada')
    await host.getByRole('button', { name: 'Continue' }).click()
    await host.getByRole('button', { name: 'Create a server' }).click()
    const wizard = host.getByRole('dialog', { name: 'Create a server' })
    await wizard.getByLabel('Server name').fill('Behind CGNAT')
    await wizard.getByRole('button', { name: 'Next' }).click()
    await wizard.locator('[data-template="empty"]').click()
    await wizard.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(wizard.getByRole('heading', { name: 'Behind CGNAT is ready' })).toBeVisible({ timeout: 45_000 })
    await wizard.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(host.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 30_000 })
    lap('server created')

    await host.locator('.server-header-button').click()
    await host.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
    const room = host.getByRole('dialog', { name: /· Server settings$/ })
    await room.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Internet access', exact: true }).click()
    const p2p = room.getByTestId('p2p-section')
    await expect(p2p).toHaveAttribute('data-state', 'off')
    await expect(p2p.getByTestId('p2p-privacy')).toContainText('peer-to-peer network')
    await p2p.getByRole('switch', { name: 'Let friends connect without port forwarding' }).click()
    // The server made a secret and started its TURN; the app's tunnel announced the host key on the (test) DHT.
    await expect(p2p).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
    // Loopback: no NAT at all, though the DHT may still call the node firewalled until its first unsolicited probe lands.
    await expect(p2p.locator('[data-nat]')).toHaveAttribute('data-nat', /^(open|easy)$/, { timeout: 15_000 })
    await expect(p2p.getByText(/0 friends are connected this way/)).toBeVisible()
    const world = JSON.parse(readFileSync(join(hostRoot, 'behind-cgnat', 'server.json'), 'utf8')) as { P2p?: { Enabled?: boolean } }
    expect(world.P2p?.Enabled).toBe(true)
    expect(existsSync(join(hostRoot, 'behind-cgnat', 'p2p.key'))).toBe(true)
    await host.screenshot({ path: join(SHOTS, 'p2p-host-settings.png'), animations: 'disabled' })
    await host.keyboard.press('Escape')
    lap('tunnel on')

    // The invite carries the secret as its fourth field.
    await host.getByRole('button', { name: 'Invite friends' }).click()
    await expect(host.getByTestId('invite-p2p-note')).toBeVisible()
    const linkInput = host.locator('.copy-row input')
    await expect(linkInput).toHaveValue(/#\/join\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    const link = await linkInput.inputValue()
    await host.keyboard.press('Escape')
    const [, serverKey, code, secret] = link.split('#/join/')[1].split('.')
    // The address in the link can't be reached (nothing listens on port 1): exactly a friend's situation.
    const unreachable = `${b64u('http://127.0.0.1:1')}.${serverKey}.${code}.${secret}`

    // ── The friend: a second desktop app joins through the tunnel ──
    friendApp = await launch(friendData)
    const friend = await appWindow(friendApp)
    await recordPeerConnections(friend)
    friend.on('console', (m) => friendConsole.push(`${m.type()}: ${m.text().slice(0, 300)}`))
    await agreeToTerms(friend)
    await friend.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await friend.getByLabel('Your name').fill('Grace')
    await friend.getByRole('button', { name: 'Continue' }).click()
    await friend.getByRole('button', { name: 'I have an invite link' }).click()
    await friend.getByLabel('Invite link').fill(`http://localhost:5199/#/join/${unreachable}`)
    const joinedAt = Date.now()
    await friend.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(friend.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 60_000 })
    lap(`friend joined (unreachable address → tunnel in ${((Date.now() - joinedAt) / 1000).toFixed(1)} s)`)

    // Chat both ways.
    await friend.getByPlaceholder('Message #general').fill('made it through the tunnel')
    await friend.getByPlaceholder('Message #general').press('Enter')
    await expect(host.locator('.message', { hasText: 'made it through the tunnel' })).toBeVisible({ timeout: 15_000 })
    await host.getByPlaceholder('Message #general').fill('welcome, no ports were opened')
    await host.getByPlaceholder('Message #general').press('Enter')
    await expect(friend.locator('.message', { hasText: 'welcome, no ports were opened' })).toBeVisible({ timeout: 15_000 })
    lap('chat')

    // The friend's own invites still name the server's address (never the tunnel's local port) and carry the key;
    // the host's settings count the friend.
    await friend.locator('.server-header-button').click()
    await friend.getByRole('menuitem', { name: 'Invite friends' }).click()
    await expect(friend.getByTestId('invite-p2p-note')).toBeVisible()
    await expect(friend.locator('.copy-row input')).toHaveValue(new RegExp(`#/join/${b64u('http://127.0.0.1:1')}\.${serverKey}\.[A-Za-z0-9_-]+\.${secret}$`))
    await friend.screenshot({ path: join(SHOTS, 'p2p-friend-invite.png'), animations: 'disabled' })
    await friend.keyboard.press('Escape')
    await host.locator('.server-header-button').click()
    await host.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
    await room.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Internet access', exact: true }).click()
    await expect(p2p.getByText(/1 friend is connected this way/)).toBeVisible({ timeout: 15_000 })
    await host.keyboard.press('Escape')

    // ── Voice: LiveKit's TURN through the tunnel, relay only ──
    await host.getByRole('button', { name: 'Create voice channel' }).click()
    await host.getByRole('radio', { name: 'Voice' }).click()
    await host.getByLabel('Name').fill('lounge')
    await host.getByRole('button', { name: 'Create', exact: true }).click()
    const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
    await expect(lounge(friend)).toBeVisible({ timeout: 15_000 })
    await lounge(host).getByRole('button').first().click()
    await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 30_000 })
    friendPage = friend
    await lounge(friend).getByRole('button').first().click()
    await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 45_000 })
    for (const page of [host, friend]) {
      await expect(lounge(page).locator('.voice-participants li')).toHaveCount(2, { timeout: 20_000 })
      await expect(lounge(page)).toContainText('Ada')
      await expect(lounge(page)).toContainText('Grace')
    }
    // The host's voice really arrives at the friend.
    await expect
      .poll(() => friend.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)), { timeout: 20_000 })
      .toBe(true)
    lap('both in voice')

    // The friend's peer connections are relay-only. (livekit-client makes them before the join answer and sets the
    // TURN server afterwards, so their constructor configs name no server; the path in use below is what counts.)
    const configs = await friend.evaluate(() => (window as unknown as { __peerConfigs: RTCConfiguration[] }).__peerConfigs)
    expect(configs.length).toBeGreaterThan(0)
    for (const c of configs) expect(c.iceTransportPolicy).toBe('relay')
    const urls = configs.flatMap((c) => (c.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])))
    for (const url of urls) expect(url).toMatch(/^turn:127\.0\.0\.1:\d+\?transport=udp$/)
    await expect
      .poll(async () => friend.evaluate(async () => {
        const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
        const types: string[] = []
        for (const pc of pcs) {
          const report = await pc.getStats()
          const byId = new Map<string, RTCStats>()
          report.forEach((s) => byId.set(s.id, s))
          report.forEach((s) => {
            const pair = s as RTCIceCandidatePairStats
            if (s.type === 'candidate-pair' && pair.nominated && pair.state === 'succeeded') {
              const local = byId.get(pair.localCandidateId) as (RTCStats & { candidateType?: string }) | undefined
              types.push(local?.candidateType ?? 'unknown')
            }
          })
        }
        return types
      }), { timeout: 20_000 })
      .toContain('relay')
    // WebRTC's any-address policy is on in the friend's window only while its voice goes through the tunnel; the host
    // (direct voice) keeps the default, a socket per adapter.
    type AppWin = { webContents: { getURL(): string; getWebRTCIPHandlingPolicy(): string } }
    const policyOf = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w: AppWin) => w.webContents.getURL().startsWith('app://'))!.webContents.getWebRTCIPHandlingPolicy())
    expect(await policyOf(friendApp!)).toBe('default_public_interface_only')
    expect(await policyOf(hostApp!)).toBe('default')
    // ...and the TURN datagrams really went through the friend's tunnel (counted in the app's main process).
    type Debug = { client: Record<string, { stats: { datagramsOut: number; datagramsIn: number } }> }
    const debug = await friendApp.evaluate(() => (globalThis as unknown as { iskraP2pDebug: () => Debug }).iskraP2pDebug())
    const tunnelStats = Object.values(debug.client)[0]?.stats
    expect(tunnelStats?.datagramsOut).toBeGreaterThan(0)
    expect(tunnelStats?.datagramsIn).toBeGreaterThan(0)
    await friend.screenshot({ path: join(SHOTS, 'p2p-friend-voice.png'), animations: 'disabled' })
    // Leaving voice puts the friend's window back on the default policy.
    await friend.getByRole('button', { name: 'Leave voice' }).click()
    await expect(friend.locator('.voice-bar')).toHaveCount(0)
    await expect.poll(() => policyOf(friendApp!)).toBe('default')
    await expect(lounge(host).locator('.voice-participants li')).toHaveCount(1, { timeout: 15_000 })

    // A new key: the host's next invite carries a different secret.
    await host.locator('.server-header-button').click()
    await host.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
    await room.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Internet access', exact: true }).click()
    await p2p.getByRole('button', { name: 'New key' }).click()
    await expect(p2p).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
    await host.keyboard.press('Escape')
    await host.getByRole('button', { name: 'Invite friends' }).click()
    await expect(linkInput).toHaveValue(/#\/join\//)
    const rotated = (await linkInput.inputValue()).split('.').pop()
    expect(rotated).not.toBe(secret)
    await host.keyboard.press('Escape')

    console.log(`p2p walkthrough:\n${timings.map(([what, ms]) => `  ${what.padEnd(60)} ${(ms / 1000).toFixed(1)} s`).join('\n')}`)
    passed = true
  } finally {
    // When something failed, say what the friend's app was told (ICE servers, LiveKit's join answer) and what it logged.
    if (friendPage && !passed) {
      const configs = await friendPage.evaluate(() => JSON.stringify((window as unknown as { __peerConfigs?: unknown[] }).__peerConfigs ?? [])).catch(() => 'n/a')
      console.log(`friend peer configs: ${configs.slice(0, 1500)}`)
      const signal = await friendPage.evaluate(() => (window as unknown as { __signal?: string[] }).__signal ?? []).catch(() => [] as string[])
      for (const frame of signal) {
        if (frame.startsWith('text:')) { console.log(`friend LiveKit first frame: ${frame}`); continue }
        try {
          const response = SignalResponse.fromBinary(Buffer.from(frame, 'base64'))
          console.log(`friend LiveKit first frame: ${response.message.case} ${response.message.case === 'join' ? JSON.stringify(response.message.value.iceServers) : ''}`)
        } catch (e) {
          console.log(`friend LiveKit first frame: undecodable (${(e as Error).message}), ${frame.length} chars`)
        }
      }
    }
    if (friendConsole.length && !passed) console.log(`--- friend console ---\n${friendConsole.slice(-60).join('\n')}`)
    for (const [name, app] of passed ? [] : ([['friend', friendApp], ['host', hostApp]] as const)) {
      const debug = await app?.evaluate(() => JSON.stringify((globalThis as unknown as { iskraP2pDebug?: () => unknown }).iskraP2pDebug?.() ?? null)).catch((e: Error) => `n/a: ${e.message}`)
      console.log(`${name} app tunnels: ${debug}`)
    }
    if (!passed) try {
      const settings = JSON.parse(readFileSync(join(hostRoot, 'behind-cgnat', 'server.json'), 'utf8')) as { P2p?: { Enabled?: boolean }; Voice?: { RtcUdpPort?: number; TurnUdpPort?: number } }
      const turnPort = settings.Voice?.TurnUdpPort || (settings.Voice?.RtcUdpPort ?? 7882) + 1
      console.log(`host server.json P2p.Enabled=${settings.P2p?.Enabled}; TURN on ${turnPort} answers STUN: ${await stunAnswers(turnPort)}`)
    } catch (e) {
      console.log(`host server.json: ${(e as Error).message}`)
    }
    await friendApp?.close()
    await hostApp?.close()
    await testnet.destroy()
    const log = join(hostRoot, 'behind-cgnat', 'server.log')
    if (existsSync(log) && !passed) {
      const lines = readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => /Restarting voice|Voice ready|TURN|turn\b|p2p|P2p|warn:|fail:|error/i.test(l) && !/livekit-webhook|\/livekit\/rtc/.test(l))
      console.log(`--- hosted server.log (voice and p2p lines) ---\n${lines.slice(-60).join('\n')}`)
    }
    for (const dir of [hostData, friendData, hostRoot]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
