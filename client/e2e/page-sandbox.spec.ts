// Profile pages can't make the viewer's device contact anyone. A fake attacker listens on 127.0.0.1 (one port per
// vector, plus STUN on UDP) and a page tries every way we know to reach it (e2e/leak-probe.ts). WebRTC is allowed to
// use loopback here (--allow-loopback-in-peer-connection), so a leak to "the internet" shows up on localhost.
// Each test first proves the probe can see a leak from a page without the wall.
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'
import { controlScript, probePage, SCRIPT_VECTORS, startAttacker, STATIC_VECTORS, type Attacker } from './leak-probe'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const LOOPBACK_RTC = '--allow-loopback-in-peer-connection'

/** The bits of Electron's WebContents the desktop test looks at (electron's types aren't installed here). */
type Guest = {
  getType(): string
  getURL(): string
  session: unknown
  executeJavaScript(code: string): Promise<unknown>
  mainFrame: { framesInSubtree: { url: string; executeJavaScript(code: string): Promise<unknown> }[] }
}

test.use({ launchOptions: { args: [LOOPBACK_RTC, '--use-fake-ui-for-media-stream'] } })

const servers: TestServer[] = []
test.afterAll(async () => Promise.all(servers.map((s) => s.stop())))
const newServer = async () => {
  const server = await startServer('Page Sandbox')
  servers.push(server)
  return server
}

async function publish(page: Page, html: string) {
  await page.locator('.me-bar').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: /Make a page|Edit page/ }).click()
  await page.getByLabel('Page HTML').fill(html)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText('Published', { exact: true })).toBeVisible()
}

async function controlLeaks(page: Page) {
  const control = await startAttacker()
  await page.evaluate(controlScript(control))
  await expect.poll(control.hits, { timeout: 10_000 }).toEqual(['control', 'control-stun'])
  await control.close()
}

/** Gives every vector time to fire (the probe's navigations start at 4 s), then expects no contact at all. */
async function expectNoContact(page: Page, attacker: Attacker) {
  await page.waitForTimeout(7000)
  expect(attacker.hits()).toEqual([])
}

test('browsers: other people\'s pages run without scripts, and nothing reaches the attacker', async ({ browser }) => {
  test.setTimeout(120_000)
  expect(STATIC_VECTORS.length + SCRIPT_VECTORS.length).toBeGreaterThan(60)
  const server = await newServer()
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await controlLeaks(friend)

  const attacker = await startAttacker()
  // Not the author's own editor preview: it runs their page with its scripts (as their own page view does), and the
  // probe's srcdoc frame then reaches the attacker by WebRTC from the author's device. That once counted here (CI, when
  // the preview lived long enough); this test is about what other people's pages can do to a viewer.
  await host.route('**/page-preview.html', (route) => route.abort())
  await publish(host, probePage(attacker))
  await host.keyboard.press('Escape')
  await host.keyboard.press('Escape')

  await friend.locator('.member-list').getByRole('button', { name: /Host/ }).click()
  await friend.getByRole('button', { name: 'Open profile page' }).click()
  const viewer = friend.getByRole('dialog', { name: "Host's page" })
  await expect(viewer).toContainText('Interactive pages run in the desktop app.')
  await expect(viewer.getByRole('button', { name: /Run scripts/ })).toHaveCount(0)
  await expect(viewer).not.toContainText('IP address')
  const frame = friend.frames().find((f) => f.url().includes('/pages/'))!
  await expect(frame.locator('h1')).toHaveText('Probe')
  await expect(frame.parentFrame()!.locator('iframe')).toHaveAttribute('sandbox', '')
  expect(frame.url()).not.toContain('scripts=1')
  await expectNoContact(friend, attacker)
  await expect(frame.locator('#log')).toHaveText('') // its scripts never ran
  await friend.screenshot({ path: join(SHOTS, 'page-sandbox-web.png') })
  await attacker.close()
})

const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(join(DESKTOP, 'dist', 'pages.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test('desktop: pages run their scripts behind a wall nothing gets through', async () => {
  test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')
  test.setTimeout(180_000)
  const server = await newServer()
  const userData = mkdtempSync(join(tmpdir(), 'iskra-pages-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', LOOPBACK_RTC],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1' },
  })
  try {
    const page = await app.firstWindow()
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Desk')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByLabel('Invite link').fill(server.ownerLink())
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()

    // Without the wall (the app page itself), the probe sees WebRTC and fetch reach it.
    await controlLeaks(page)

    // Every page view lives in the page session, with its rules.
    type View = { url: string; walled: boolean; log: string | null }
    const views = (): Promise<View[]> => app.evaluate(async ({ session, webContents }) => Promise.all((webContents.getAllWebContents() as Guest[])
      .filter((w) => w.getType() === 'webview')
      .map(async (w) => ({
        url: w.getURL().slice(0, 60),
        walled: w.session === session.fromPartition('iskra-pages'),
        log: (await w.executeJavaScript("document.getElementById('log')?.textContent ?? ''").catch(() => null)) as string | null,
      }))))

    // The editor's preview runs the probe in a page view too.
    const attacker = await startAttacker()
    await publish(page, probePage(attacker))
    await expect.poll(async () => (await views()).filter((v) => v.url.startsWith('data:text/html') && v.walled && v.log?.includes('fetch:')).length, { timeout: 15_000 }).toBe(1)
    await page.screenshot({ path: join(SHOTS, 'page-sandbox-desktop-editor.png') })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // The published page, with its scripts on and no prompt.
    await page.locator('.member-list').getByRole('button', { name: /Desk/ }).click()
    await page.getByRole('button', { name: 'Open profile page' }).click()
    const viewer = page.getByRole('dialog', { name: "Desk's page" })
    await expect(viewer.locator('webview.page-frame')).toBeVisible()
    await expect(viewer).not.toContainText('IP address')
    await expect(viewer).not.toContainText('desktop app')
    await expect.poll(async () => (await views()).filter((v) => v.url.includes('/pages/') && v.walled && v.log?.includes('fetch:')).length, { timeout: 15_000 }).toBe(1)
    expect((await views()).every((v) => v.walled)).toBe(true)

    // A child frame of the page has its own, untouched WebRTC (browsers can't stop that): here it goes nowhere either.
    const childRtc = await app.evaluate(({ webContents }, { stun, turn }) => {
      const view = (webContents.getAllWebContents() as Guest[]).find((w) => w.getType() === 'webview' && w.getURL().includes('/pages/'))!
      const child = view.mainFrame.framesInSubtree.find((f) => f.url === 'about:srcdoc')!
      return child.executeJavaScript(`(() => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stun}' },
        { urls: 'turn:127.0.0.1:${turn}?transport=tcp', username: 'u', credential: 'p' }] }); pc.createDataChannel('x');
        return pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => typeof RTCPeerConnection) })()`)
    }, { stun: attacker.udp['rtc-stun'], turn: attacker.tcp.rtc })
    expect(childRtc).toBe('function')

    // The app page can't open anything else in a page view, nor one outside the page session.
    await page.evaluate((src) => {
      const w = document.createElement('webview')
      w.setAttribute('src', src)
      w.setAttribute('partition', 'persist:other')
      document.body.append(w)
      setTimeout(() => w.remove(), 3000)
    }, `http://127.0.0.1:${attacker.tcp.webview}/x`)

    await expectNoContact(page, attacker)
    expect((await views()).some((v) => v.url.includes('127.0.0.1'))).toBe(false)
    // Navigations were refused, so the page is still there.
    expect((await views()).some((v) => v.url.includes('/pages/') && v.log?.includes('fetch:'))).toBe(true)
    await page.screenshot({ path: join(SHOTS, 'page-sandbox-desktop.png') })
    await attacker.close()
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
