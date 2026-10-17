// "Report a bug" in the desktop app: a window of its own (a pop-out the main page renders), so the app stays usable.
// Its screenshots are of one of Iskra's own windows, picked from a list (the main window, open pop-outs, never the
// report itself), now or after a countdown that leaves the main window alone. Only one report window, and it closes
// with the page.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { agreeToTerms, appWindow, SHOTS, startServer, type TestServer } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const ELECTRON = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/popout.html'))

test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')

type Info = { name: string; kind: string; alwaysOnTop: boolean; clickThrough: boolean; bounds: { width: number; height: number } }

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Report Test', false)
})
test.afterAll(async () => server?.stop())

const popouts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { iskraPopouts: () => Info[] }).iskraPopouts())

async function popoutPage(app: ElectronApplication, testId: string): Promise<Page> {
  const find = async () => {
    for (const p of app.windows()) {
      if (!p.url().endsWith('/popout.html')) continue
      if (await p.getByTestId(testId).count().catch(() => 0)) return p
    }
    return null
  }
  await expect.poll(find, { timeout: 15_000 }).not.toBeNull()
  return (await find())!
}

test('the bug report is a window of its own that takes screenshots of the app’s windows', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1' },
  })
  try {
    const page = await appWindow(app)
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Desk')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByLabel('Invite link').fill(server.ownerLink())
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()

    // A channel popped out, to have a second window to take a picture of.
    await page.getByRole('button', { name: 'Pop out channel' }).click()
    await popoutPage(app, 'popout-chat')

    // Ctrl+Shift+B: the report opens in its own window, and the main window has no dialog over it.
    await page.keyboard.press('Control+Shift+B')
    const report = await popoutPage(app, 'popout-report')
    await expect(report.locator('.popout-title')).toHaveText('Report a bug')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await popouts(app)).map((p) => p.kind).sort()).toEqual(['chat', 'report'])
    const info = (await popouts(app)).find((p) => p.kind === 'report')!
    expect(info.bounds.width).toBeGreaterThanOrEqual(420)
    expect(info.bounds.height).toBeGreaterThanOrEqual(560)
    // Again: the same window, not a second one.
    await page.keyboard.press('Control+Shift+B')
    await page.waitForTimeout(500)
    expect((await popouts(app)).filter((p) => p.kind === 'report')).toHaveLength(1)

    const form = report.getByRole('form', { name: 'Report a bug' })
    await form.getByLabel('What happened?').fill('The menu closes by itself')
    // The windows it can take a picture of: the main one and the channel, not the report.
    const target = form.getByLabel('Screenshot of')
    await expect(target.locator('option')).toHaveText(['Main window', 'Channel: #general · Report Test'])

    // Now: the main window.
    await form.getByRole('button', { name: 'Take a screenshot' }).click()
    await expect(form.getByRole('img', { name: 'Screenshot 1' })).toBeVisible({ timeout: 15_000 })
    // The picture is of the main window, at its size (not this small report window).
    const size = await form.getByRole('img', { name: 'Screenshot 1' }).evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])
    const mainSize = await page.evaluate(() => [window.innerWidth, window.innerHeight])
    expect(Math.abs(size[0] / size[1] - mainSize[0] / mainSize[1])).toBeLessThan(0.05)

    // The channel's window.
    await target.selectOption({ label: 'Channel: #general · Report Test' })
    await form.getByRole('button', { name: 'Take a screenshot' }).click()
    await expect(form.getByRole('img', { name: 'Screenshot 2' })).toBeVisible({ timeout: 15_000 })

    // In 5 seconds: cancelled, nothing is taken.
    await target.selectOption({ label: 'Main window' })
    await form.getByRole('button', { name: 'In 5 seconds' }).click()
    await expect(form.getByTestId('bug-report-countdown')).toHaveText('Screenshot in 5…')
    await form.locator('.bug-report-countdown').getByRole('button', { name: 'Cancel' }).click()
    await report.waitForTimeout(5_500)
    await expect(form.getByRole('img', { name: 'Screenshot 3' })).toHaveCount(0)
    await expect(form.getByTestId('bug-report-countdown')).toHaveCount(0)

    // In 5 seconds again: meanwhile a menu opens in the main window, and it's still open when the picture is taken.
    await form.getByRole('button', { name: 'In 5 seconds' }).click()
    await expect(form.getByTestId('bug-report-countdown')).toBeVisible()
    await report.screenshot({ path: join(SHOTS, 'desktop-bug-report-countdown.png') })
    await page.locator('.me-status-button').click()
    const menu = page.getByRole('menuitem', { name: /Report a bug/ })
    await expect(menu).toBeVisible()
    await expect(form.getByTestId('bug-report-countdown')).toHaveText('Screenshot in 1…', { timeout: 8_000 })
    await expect(menu).toBeVisible()
    await expect(form.getByRole('img', { name: 'Screenshot 3' })).toBeVisible({ timeout: 15_000 })
    await expect(form.getByTestId('bug-report-countdown')).toHaveCount(0)
    expect(await form.getByRole('img', { name: 'Screenshot 2' }).count()).toBe(1)
    await expect(form.getByText('3 of 5')).toBeVisible()
    await report.screenshot({ path: join(SHOTS, 'desktop-bug-report.png') })
    await page.keyboard.press('Escape')

    // The logs: the page's own lines and the desktop app's (from its log file), in one timeline, in the server's format.
    await report.getByRole('button', { name: "See what's included" }).click()
    const preview = report.getByTestId('bug-report-preview')
    await expect(preview).toContainText(/INFO  desk  life   start       -       ver=/)
    await expect(preview).toContainText(/INFO  app   conn   online      -       srv=[0-9a-f]{4} conn=[0-9a-z]{1,8} path=direct/)
    await expect(preview).toContainText('== Servers ==')
    await report.locator('.bug-report-toggle').click() // hide it again
    // The app log file in userData/logs has both too (the page's lines are mirrored there).
    const logs = join(userData, 'logs')
    const file = readdirSync(logs).find((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))!
    const text = readFileSync(join(logs, file), 'utf8')
    expect(text).toMatch(/ INFO  desk  ui     opened      -       what=window/)
    expect(text).toMatch(/ INFO  app   conn   online /)
    expect(text).not.toContain('Report Test') // the server's name

    // Closing it keeps the draft; opening it from the menu brings it back.
    await report.getByRole('button', { name: 'Close' }).click()
    await expect.poll(async () => (await popouts(app)).map((p) => p.kind)).toEqual(['chat'])
    await page.locator('.me-status-button').click()
    await page.getByRole('menuitem', { name: /Report a bug/ }).click()
    const again = await popoutPage(app, 'popout-report')
    await expect(again.getByLabel('What happened?')).toHaveValue('The menu closes by itself')
    await expect(again.getByText('3 of 5')).toBeVisible()

    // The report window goes with the page (here a reload; quitting closes it the same way).
    await page.reload()
    await expect.poll(async () => (await popouts(app)).length, { timeout: 15_000 }).toBe(0)
    await expect.poll(() => app.windows().filter((p) => p.url().endsWith('/popout.html')).length).toBe(0)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
