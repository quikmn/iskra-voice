// Rent a server on DigitalOcean from the desktop app, against a fake DigitalOcean API on 127.0.0.1 (never the real
// one): Connect to DigitalOcean (OAuth with PKCE, through the loopback callback), the region and price, Create, the
// "droplet" (a real local iskra-server started from the setup text the app sent), the owner claim, the server
// document. Then the token fallback, a failure, and deleting what was created.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { DESKTOP_SKIP, desktopBuilt } from './desktopBuild'
import { agreeToTerms, appWindow, freePort, openServerSettings, SHOTS } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const SERVER_DLL = resolve(HERE, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const built = desktopBuilt(SERVER_DLL)
test.skip(!built, DESKTOP_SKIP)

const CLIENT_ID = 'f'.repeat(64)
const OAUTH_TOKEN = 'doo_v1_' + 'c'.repeat(64)
const PAT = 'dop_v1_' + 'd'.repeat(64)

interface Seen {
  method: string
  path: string
  body: Record<string, unknown> | null
}

/** A fake DigitalOcean: OAuth, sizes, regions, droplets that are real local Iskra servers, firewalls. */
class FakeDigitalOcean {
  server!: Server
  url = ''
  seen: Seen[] = []
  challenge = ''
  failFirewall = false
  droplets = new Map<number, { world: string; proc: ChildProcess }>()
  /** Every world folder made, to remove at the end. */
  worlds: { world: string; proc: ChildProcess }[] = []
  private nextId = 1000

  readonly serverPort: number

  constructor(serverPort: number) {
    this.serverPort = serverPort
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req).then(({ status, json, location }) => {
      res.writeHead(status, location ? { Location: location } : { 'Content-Type': 'application/json' })
      res.end(json === undefined ? '' : JSON.stringify(json))
    }))
    const port = await freePort()
    await new Promise<void>((done) => this.server.listen(port, '127.0.0.1', done))
    this.url = `http://127.0.0.1:${port}`
  }

  async stop(): Promise<void> {
    await Promise.all(this.worlds.map((d) => (d.proc.exitCode === null && d.proc.signalCode === null
      ? new Promise((done) => {
        d.proc.once('exit', done)
        d.proc.kill()
      })
      : undefined)))
    await new Promise((done) => this.server?.close(done))
    for (const d of this.worlds) {
      try {
        rmSync(d.world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // a file still held for a moment: it's in the temp folder
      }
    }
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; json?: unknown; location?: string }> {
    const url = new URL(req.url ?? '/', this.url)
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null
    this.seen.push({ method: req.method ?? 'GET', path: url.pathname, body })

    if (url.pathname === '/v1/oauth/authorize') {
      const q = url.searchParams
      const redirect = q.get('redirect_uri') ?? ''
      if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect)) {
        return { status: 400, json: { error: 'invalid_request' } }
      }
      this.challenge = q.get('code_challenge') ?? ''
      return { status: 302, location: `${redirect}?code=fake-code&state=${encodeURIComponent(q.get('state') ?? '')}` }
    }
    if (url.pathname === '/v1/oauth/token') {
      const form = new URLSearchParams(raw)
      const verified = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === this.challenge
      if (form.get('code') !== 'fake-code' || !verified || form.get('client_secret') !== null) return { status: 400, json: { error: 'invalid_grant' } }
      return { status: 200, json: { access_token: OAUTH_TOKEN, token_type: 'bearer', expires_in: 3600 } }
    }

    const auth = req.headers.authorization
    if (auth !== `Bearer ${OAUTH_TOKEN}` && auth !== `Bearer ${PAT}`) return { status: 401, json: { id: 'unauthorized', message: 'Unable to authenticate you' } }
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /v2/sizes') {
      return { status: 200, json: { sizes: [
        { slug: 's-1vcpu-512mb-10gb', memory: 512, vcpus: 1, disk: 10, price_monthly: 4, regions: ['ams3', 'fra1', 'nyc3'], available: true },
        { slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25, price_monthly: 6, regions: ['ams3', 'fra1', 'nyc3'], available: true },
      ] } }
    }
    if (route === 'GET /v2/regions') {
      return { status: 200, json: { regions: [
        { slug: 'ams3', name: 'Amsterdam 3', available: true, sizes: ['s-1vcpu-512mb-10gb', 's-1vcpu-1gb'] },
        { slug: 'fra1', name: 'Frankfurt 1', available: true, sizes: ['s-1vcpu-1gb'] },
        { slug: 'nyc3', name: 'New York 3', available: true, sizes: ['s-1vcpu-1gb'] },
      ] } }
    }
    if (route === 'POST /v2/droplets') {
      const id = this.nextId++
      this.droplets.set(id, this.boot(String(body?.user_data ?? '')))
      return { status: 202, json: { droplet: { id, status: 'new', networks: { v4: [] } } } }
    }
    if (route === 'POST /v2/firewalls') {
      if (this.failFirewall) return { status: 403, json: { id: 'forbidden', message: 'You are not authorized to perform this operation' } }
      return { status: 202, json: { firewall: { id: `fw-${this.nextId}` } } }
    }
    const droplet = url.pathname.match(/^\/v2\/droplets\/(\d+)$/)
    if (droplet && req.method === 'GET') {
      return { status: 200, json: { droplet: { id: Number(droplet[1]), status: 'active', networks: { v4: [{ ip_address: '203.0.113.7', type: 'public' }] } } } }
    }
    if (droplet && req.method === 'DELETE') {
      const d = this.droplets.get(Number(droplet[1]))
      d?.proc.kill()
      this.droplets.delete(Number(droplet[1]))
      return { status: 204 }
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/v2/firewalls/')) return { status: 204 }
    return { status: 404, json: { id: 'not_found', message: 'The resource you were accessing could not be found.' } }
  }

  /** "Boots" the droplet: a real iskra-server with the settings from the setup text, on this computer only. */
  private boot(userData: string): { world: string; proc: ChildProcess } {
    const json = userData.split("<<'ISKRA_SERVER_JSON'\n")[1].split('\nISKRA_SERVER_JSON\n')[0]
    const settings = JSON.parse(json) as { Name: string; OwnerClaim: string; Template?: string }
    const world = mkdtempSync(join(tmpdir(), 'iskra-e2e-do-'))
    writeFileSync(join(world, 'server.json'), JSON.stringify({
      Name: settings.Name, Template: settings.Template, OwnerClaim: settings.OwnerClaim,
      Port: this.serverPort, LocalOnly: true, AppUrl: 'http://localhost:5173', Voice: { Enabled: false }, Updates: { Mode: 'off' }, Captions: { ModelDownload: false },
    }))
    const proc = spawn('dotnet', [SERVER_DLL, world], { stdio: ['pipe', 'ignore', 'ignore'] })
    this.worlds.push({ world, proc })
    return { world, proc }
  }
}

let fake: FakeDigitalOcean
test.beforeAll(async () => {
  fake = new FakeDigitalOcean(await freePort())
  await fake.start()
})
test.afterAll(async () => {
  await fake?.stop()
})

test('rent a server on DigitalOcean: connect, create, become owner, save the document; then a failure is cleaned up', async () => {
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-do-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-host-do-'))
  const saved = join(userData, 'server-document.md')
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: {
      ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1', ISKRA_HOST_ROOT: hostRoot,
      ISKRA_DO_API: fake.url, ISKRA_DO_SERVER_URL: `http://localhost:${fake.serverPort}`, ISKRA_DO_OAUTH_CLIENT_ID: CLIENT_ID,
    },
  })
  try {
    const page = await appWindow(app)
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Ada')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Create a server' }).click()
    await page.getByRole('dialog', { name: 'Create a server' }).getByRole('button', { name: 'Rent one on DigitalOcean' }).click()

    // 1. The account: cost, credit and the referral link, said plainly.
    const dialog = page.getByRole('dialog', { name: 'Rent a server on DigitalOcean' })
    await expect(dialog).toContainText('About $6 a month')
    await expect(dialog).toContainText('New DigitalOcean accounts get signup credit')
    await expect(dialog.getByTestId('do-referral')).toHaveText(/Iskra gets a little DigitalOcean credit that helps pay for our own server\. You pay DigitalOcean directly; we never see your server or your card\./)
    await expect(dialog.getByRole('link', { name: 'Open DigitalOcean' })).toHaveAttribute('href', 'https://m.do.co/c/5ed476bab2ca')
    await page.screenshot({ path: join(SHOTS, 'digitalocean-1-account.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'I have an account' }).click()

    // 2. Connect in the browser (here: the fake authorize page sends it straight back to the loopback callback).
    await expect(dialog.getByRole('heading', { name: 'Connect Iskra to DigitalOcean' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Connect to DigitalOcean' }).click()

    // 3. Where and what, with DigitalOcean's own price.
    await expect(dialog.getByRole('heading', { name: 'Your server' })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByTestId('do-size')).toContainText('1 GB memory, 1 CPU, 25 GB disk')
    await expect(dialog.getByTestId('do-size')).toContainText('$6 a month')
    await dialog.getByLabel('Location').selectOption('fra1')
    await dialog.getByLabel('Server name').fill('Cloud Night')
    await expect(dialog.getByLabel('Also allow SSH (terminal access)')).not.toBeChecked()
    await page.screenshot({ path: join(SHOTS, 'digitalocean-2-place.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Create server for $6 a month' }).click()

    // 4. Progress, then owner of the new server.
    await expect(dialog.getByTestId('do-progress')).toBeVisible()
    const done = page.getByRole('dialog', { name: 'Rent a server on DigitalOcean' }).getByTestId('do-done')
    await expect(done).toBeVisible({ timeout: 90_000 })
    await expect(done).toContainText(`http://localhost:${fake.serverPort}`)
    await expect(done).toContainText('$6 a month at DigitalOcean')
    await expect(dialog).toContainText('Daily backups and automatic updates are on')
    await page.screenshot({ path: join(SHOTS, 'digitalocean-3-done.png'), animations: 'disabled' })

    // What the app asked DigitalOcean for.
    const create = fake.seen.find((s) => s.method === 'POST' && s.path === '/v2/droplets')!
    expect(create.body).toMatchObject({ name: 'iskra-cloud-night', region: 'fra1', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', tags: ['iskra'], monitoring: false })
    expect(String(create.body?.user_data)).toMatch(/"OwnerClaim": "[A-Za-z0-9_-]{43}"/)
    expect(String(create.body?.user_data)).toContain('"Backups": {')
    const firewall = fake.seen.find((s) => s.method === 'POST' && s.path === '/v2/firewalls')!
    expect((firewall.body?.inbound_rules as { ports: string }[]).map((r) => r.ports)).toEqual(['80', '443', '7881', '7882'])

    // 5. The server document: saved through the app's own Save dialog, with the facts and no secrets.
    await app.evaluate(({ dialog: d }, file) => {
      d.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as unknown as typeof d.showSaveDialog
    }, saved)
    await dialog.getByRole('button', { name: 'Save your server document' }).click()
    await expect(dialog.getByRole('button', { name: 'Saved' })).toBeVisible()
    const doc = readFileSync(saved, 'utf8')
    expect(doc).toContain('# Cloud Night: your Iskra server')
    expect(doc).toContain('"iskra-cloud-night" in Frankfurt 1')
    expect(doc).toContain('journalctl -u iskra')
    expect(doc).not.toContain(OAUTH_TOKEN)
    expect(doc).not.toMatch(/OwnerClaim|doo_v1|dop_v1/)
    // The token never reached the page.
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(OAUTH_TOKEN)

    await dialog.getByRole('button', { name: 'Go to my server' }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 20_000 })
    // Owner: the owner-only sections are there.
    await openServerSettings(page, 'Backup & move')
    await expect(page.getByTestId('backup-section')).toBeVisible()
    await page.keyboard.press('Escape')

    // The fallback: a pasted token. A wrong one is refused; a firewall the token may not make fails the setup, and the
    // droplet that was already made is deleted on request.
    fake.failFirewall = true
    await page.getByRole('button', { name: 'Join a server' }).click()
    await page.getByRole('button', { name: 'start your own server' }).click()
    await page.getByRole('dialog', { name: 'Create a server' }).getByRole('button', { name: 'Rent one on DigitalOcean' }).click()
    await dialog.getByRole('button', { name: 'I have an account' }).click()
    await dialog.getByRole('button', { name: 'Use an API token instead' }).click()
    await expect(dialog.getByRole('link', { name: 'API → Tokens' })).toHaveAttribute('href', 'https://cloud.digitalocean.com/account/api/tokens')
    await expect(dialog).toContainText('droplet (create, read, delete), firewall (create, read, delete), regions (read), sizes (read) and tag (create)')
    await dialog.getByLabel('Token').fill('dop_v1_' + 'e'.repeat(64))
    await dialog.getByRole('button', { name: 'Continue' }).click()
    await expect(dialog.getByRole('alert')).toContainText('DigitalOcean didn’t accept that token')
    await dialog.getByLabel('Token').fill(PAT)
    await dialog.getByRole('button', { name: 'Continue' }).click()
    await expect(dialog.getByRole('heading', { name: 'Your server' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Create server for/ })).toBeDisabled() // a name first
    await dialog.getByLabel('Server name').fill('Second Try')
    await dialog.getByRole('button', { name: /Create server for/ }).click()
    const alert = dialog.getByRole('alert')
    await expect(alert).toContainText('Iskra is missing a permission at DigitalOcean')
    await expect(alert).toContainText('DigitalOcean said: You are not authorized')
    await expect(alert).toContainText('A server was already created in your DigitalOcean account')
    await page.screenshot({ path: join(SHOTS, 'digitalocean-4-failed.png'), animations: 'disabled' })
    const before = fake.droplets.size
    await dialog.getByRole('button', { name: 'Delete it at DigitalOcean' }).click()
    await expect(alert).toContainText('Nothing from this try is left in your DigitalOcean account')
    expect(fake.droplets.size).toBe(before - 1)
    expect(fake.seen.filter((s) => s.method === 'DELETE').map((s) => s.path)).toEqual(['/v2/droplets/1001'])
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(hostRoot, { recursive: true, force: true })
  }
})
