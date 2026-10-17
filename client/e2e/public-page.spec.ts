import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Landing Crew')
})
test.afterAll(async () => server?.stop())

test('the public page says nothing until the owner turns it on; then a stranger opens it and joins', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await createInviteLink(host)

  // ── Off (the default): a browser at the server's address learns only that it's an Iskra server.
  const stranger = await (await browser.newContext({ colorScheme: 'dark' })).newPage()
  const response = await stranger.goto(`${server.url}/`)
  expect(response?.headers()['content-security-policy']).toMatch(/^default-src 'none'; style-src 'sha256-/)
  expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow')
  await expect(stranger.getByRole('heading', { name: 'This is an Iskra server' })).toBeVisible()
  await expect(stranger.locator('body')).not.toContainText('Landing Crew')
  await expect(stranger.locator('img')).toHaveCount(0)
  await stranger.screenshot({ path: join(SHOTS, 'public-page-off.png') })

  // ── The owner turns it on in Server settings → Overview, writes a line and picks the invite for the Join button.
  const room = await openServerSettings(host, 'Overview')
  const section = room.getByTestId('landing-section')
  await section.scrollIntoViewIfNeeded()
  await expect(section).toContainText('Public page')
  await section.getByTestId('landing-enabled').click()
  await expect(section.getByTestId('landing-enabled')).toHaveAttribute('aria-checked', 'true')
  await section.getByTestId('landing-description').fill('Tuesday game nights. <b>Bring snacks</b>')
  await section.getByTestId('landing-save').click()
  await expect(section).toContainText('Description saved.')
  const invite = section.getByTestId('landing-invite')
  await expect(invite.locator('option').nth(1)).toBeAttached()
  await invite.selectOption({ index: 1 })
  await expect(section).not.toContainText('Make an invite first')
  await section.getByTestId('landing-counts').click() // checked once the server says so
  await expect(section.getByTestId('landing-counts')).toBeChecked()
  await host.screenshot({ path: join(SHOTS, 'public-page-settings.png') })
  await host.keyboard.press('Escape')

  // ── The stranger reloads: name, description (as text), counts and a Join button; still not indexed.
  await stranger.reload()
  await expect(stranger.getByRole('heading', { name: 'Landing Crew' })).toBeVisible()
  await expect(stranger.locator('.description')).toHaveText('Tuesday game nights. <b>Bring snacks</b>')
  await expect(stranger.locator('[data-counts]')).toHaveText('1 member · 1 online')
  const joinButton = stranger.getByRole('link', { name: 'Join in your browser' })
  await expect(joinButton).toBeVisible()
  await expect(stranger.getByRole('link', { name: 'Open in the Iskra app' })).toHaveAttribute('href', /^iskra:\/\/join\//)
  await stranger.screenshot({ path: join(SHOTS, 'public-page-dark.png') })

  const light = await (await browser.newContext({ colorScheme: 'light' })).newPage()
  await light.goto(`${server.url}/`)
  await expect(light.getByRole('heading', { name: 'Landing Crew' })).toBeVisible()
  await light.screenshot({ path: join(SHOTS, 'public-page-light.png') })

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sv-SE' })).newPage()
  await phone.goto(`${server.url}/`)
  await expect(phone.getByRole('link', { name: 'Gå med i webbläsaren' })).toBeVisible()
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await phone.screenshot({ path: join(SHOTS, 'public-page-phone.png') })

  // ── Join takes the stranger into the app with the invite.
  await joinButton.click()
  await expect(stranger.getByText("You've been invited")).toBeVisible()
  await agreeToTerms(stranger)
  await stranger.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await stranger.getByLabel('Your name').fill('Stranger')
  await stranger.getByRole('button', { name: 'Join' }).click()
  await expect(stranger.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(host.locator('.member-list')).toContainText('Stranger')
})
