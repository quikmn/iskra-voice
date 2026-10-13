import { expect, test } from '@playwright/test'
import { agreeToTerms, joinVia, send, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Recovery Test')
})
test.afterAll(async () => server?.stop())

test('a recovery key brings your account back on a fresh device, owner role included', async ({ browser }) => {
  const ownerLink = server.ownerLink()
  const first = await (await browser.newContext()).newPage()
  await joinVia(first, ownerLink, 'Host')
  await send(first, 'written on the first device')

  // The nudge asks for the key to be saved; copy it from settings.
  await expect(first.locator('.nudge')).toBeVisible()
  await first.getByRole('button', { name: 'My settings', exact: true }).click()
  await first.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Recovery key', exact: true }).click()
  await first.getByRole('button', { name: 'Show recovery key' }).click()
  const recoveryKey = (await first.locator('.recovery-key').innerText()).trim()
  expect(recoveryKey).toMatch(/^ISKRA-/)
  await first.getByRole('button', { name: 'Copy' }).click()
  await first.keyboard.press('Escape')
  await expect(first.locator('.nudge')).toHaveCount(0)

  // A brand-new browser (nothing stored) restores from the key.
  const second = await (await browser.newContext()).newPage()
  await second.goto(ownerLink) // any link to the server works once you're a member
  await agreeToTerms(second)
  await second.getByRole('button', { name: /I already use Iskra/ }).click()
  await second.getByRole('button', { name: /Use my recovery key/ }).click()
  await second.getByLabel('Recovery key').fill(` ${recoveryKey.toLowerCase().replace(/-/g, ' ')} `)
  await expect(second.getByText('Key looks right.')).toBeVisible()
  // No name to type: a restored account is the same person, and its name comes back from the server (UX audit P1).
  await expect(second.getByText('Welcome back. Paste your recovery key: your name and profile come back from your servers.')).toBeVisible()
  await expect(second.getByLabel('Your name')).toHaveCount(0)
  await second.getByRole('button', { name: 'Restore my account' }).click()

  await expect(second.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(second.locator('.me-bar')).toContainText('Host')
  await expect(first.locator('.member-list .member-name', { hasText: /^Host$/ })).toHaveCount(1)
  await expect(second.locator('.me-text')).toContainText('owner')
  await expect(second.getByText('written on the first device')).toBeVisible()
  await expect(second.locator('.nudge')).toHaveCount(0) // restoring means you have the key
})
