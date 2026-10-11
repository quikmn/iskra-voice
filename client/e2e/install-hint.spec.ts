import { join } from 'node:path'
import { devices, expect, test, type Browser, type BrowserContextOptions } from '@playwright/test'
import { joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Install Hint Test')
})
test.afterAll(async () => server?.stop())

const { defaultBrowserType: _i, ...iphone } = devices['iPhone 13']
const { defaultBrowserType: _a, ...pixel } = devices['Pixel 7']

/** A phone that looks like a person's: the hint stays away from automated browsers, so hide that we are one. */
async function phone(browser: Browser, device: BrowserContextOptions, standalone = false) {
  const context = await browser.newContext(device)
  await context.addInitScript((standalone: boolean) => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false })
    if (standalone) Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true })
  }, standalone)
  return context.newPage()
}

test('iPhone in Safari: add to Home Screen hint, dismissed for good', async ({ browser }) => {
  const page = await phone(browser, iphone)
  await page.goto('/')
  const hint = page.getByRole('complementary', { name: 'Get the Iskra app' })
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('Add Iskra to your Home Screen')
  await expect(hint).toContainText('Notifications on iPhone only work from the Home Screen app')
  await page.waitForTimeout(1000) // let it slide in
  await page.screenshot({ path: join(SHOTS, 'install-hint-iphone.png') })

  await hint.getByRole('button', { name: 'Dismiss' }).click()
  await expect(hint).toBeHidden()
  await page.reload()
  await expect(page.getByRole('button', { name: /I already use Iskra/ })).toBeVisible()
  await expect(hint).toBeHidden()
  await page.context().close()
})

test('iPhone Home Screen app: no hint', async ({ browser }) => {
  const page = await phone(browser, iphone, true)
  await page.goto('/')
  await expect(page.getByRole('button', { name: /I already use Iskra/ })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByRole('complementary', { name: 'Get the Iskra app' })).toBeHidden()
  await page.context().close()
})

test('Android in Chrome, signed in: offers the Android app', async ({ browser }) => {
  const page = await phone(browser, pixel)
  await joinVia(page, server.ownerLink(), 'Pixel')
  const hint = page.getByRole('complementary', { name: 'Get the Iskra app' })
  await expect(hint).toBeVisible()
  await expect(hint.getByRole('link', { name: 'Get the Android app' })).toHaveAttribute('href', 'https://github.com/quikmn/iskra-voice/releases/latest')
  // Clear of the message box.
  const hintBox = (await hint.boundingBox())!
  const composer = (await page.getByPlaceholder('Message #general').boundingBox())!
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(composer.y)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(SHOTS, 'install-hint-android.png') })
  await hint.getByRole('button', { name: 'Dismiss' }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
  await expect(hint).toBeHidden()
  await page.context().close()
})

test('computers get no hint; the Android app’s asset links are served', async ({ browser, request }) => {
  const page = await phone(browser, { viewport: { width: 1280, height: 800 } })
  await page.goto('/')
  await expect(page.getByRole('button', { name: /I already use Iskra/ })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByRole('complementary', { name: 'Get the Iskra app' })).toBeHidden()
  await page.context().close()

  const links = await request.get('/.well-known/assetlinks.json')
  expect(links.ok()).toBe(true)
  expect(links.headers()['content-type']).toContain('application/json')
  const statements = await links.json()
  expect(statements[0]).toMatchObject({
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: 'foo.iskra.app' },
  })
  expect(statements[0].target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
})
