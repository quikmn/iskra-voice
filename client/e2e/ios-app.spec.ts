import { join } from 'node:path'
import { devices, expect, test } from '@playwright/test'
import { agreeToTerms, SHOTS } from './helpers'

const { defaultBrowserType: _i, ...iphone } = devices['iPhone 13']

// The iPhone/iPad app (mobile/) runs this client with Capacitor's bridge in place; here a stand-in for it.
test('inside the iPhone app: no Home Screen hints, no web push prompt', async ({ browser }) => {
  const context = await browser.newContext(iphone)
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false })
    ;(window as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    delete (window as { PushManager?: unknown }).PushManager
    delete (window as { Notification?: unknown }).Notification
  })
  const page = await context.newPage()
  await page.goto('/')
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill('Phone')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('complementary', { name: 'Get the Iskra app' })).toBeHidden()

  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Notifications' }).click()
  await expect(page.getByText('coming to the iPhone and iPad app')).toBeVisible()
  await expect(page.getByText('add Iskra to your Home Screen first')).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS, 'ios-app-push.png'), animations: 'disabled' })
  await context.close()
})

test('Universal Links: apple-app-site-association names the app and only invite and device links', async ({ request }) => {
  const response = await request.get('/.well-known/apple-app-site-association')
  expect(response.ok()).toBe(true)
  const { applinks, webcredentials } = (await response.json()) as {
    applinks: { details: { appIDs: string[]; components: Record<string, string>[] }[] }
    webcredentials: { apps: string[] }
  }
  expect(applinks.details[0].appIDs).toEqual(['BWX2M8XSNZ.foo.iskra.app'])
  // App lock passkeys in the app are app.iskra.foo's.
  expect(webcredentials.apps).toEqual(['BWX2M8XSNZ.foo.iskra.app'])
  expect(applinks.details[0].components.map((c) => c['#'])).toEqual(['/join/*', '/link/*'])
})
