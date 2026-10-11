import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Sign Out')
})
test.afterAll(async () => server?.stop())

test('signing out of the only device warns first, can leave the servers, and lands on the first-run choice', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const temp = await (await browser.newContext()).newPage()
  await joinVia(temp, await createInviteLink(host), 'Temp')
  await expect(host.locator('.member-list')).toContainText('Temp')

  await openSettings(temp, 'Devices')
  await temp.getByRole('button', { name: 'Sign out of this device' }).click()
  const dialog = temp.getByRole('dialog', { name: 'Sign out of this device' })
  // Only device, recovery key never saved: a strong warning, and leaving the servers is on.
  await expect(dialog.getByRole('alert')).toContainText('You’ll lose this account for good')
  await expect(dialog.getByRole('button', { name: 'Save recovery key first' })).toBeVisible()
  await expect(dialog.getByLabel(/Also leave my servers/)).toBeChecked()
  const confirm = dialog.getByRole('button', { name: 'Sign out', exact: true })
  await expect(confirm).toBeDisabled()
  await temp.waitForTimeout(300) // the dialog fades in
  await temp.screenshot({ path: join(SHOTS, 'sign-out-warning.png') })
  await dialog.getByLabel('I understand this account will be gone for good').check()
  await confirm.click()

  // A fresh start: both choices, side by side.
  await expect(temp.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible()
  await expect(temp.getByRole('button', { name: /I already use Iskra on another device/ })).toBeVisible()
  await temp.screenshot({ path: join(SHOTS, 'onboarding-choice.png') })
  // Temp left the server.
  await expect(host.locator('.member-list')).not.toContainText('Temp')

  // "I already use Iskra" leads to linking or the recovery key.
  await temp.getByRole('button', { name: /I already use Iskra/ }).click()
  await expect(temp.getByRole('button', { name: /Link with my other device/ })).toBeVisible()
  await expect(temp.getByRole('button', { name: /Use my recovery key/ })).toBeVisible()
})

test('an invite link also offers "I already use Iskra" before making an account', async ({ browser }) => {
  const other = await startServer('Invite Choice')
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, other.ownerLink(), 'Owner')
  const page = await (await browser.newContext()).newPage()
  await page.goto(await createInviteLink(host))
  await expect(page.getByText("You've been invited")).toBeVisible()
  await expect(page.getByRole('button', { name: /I already use Iskra on another device/ })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'onboarding-choice-invite.png') })
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill('Newcomer')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
  await other.stop()
})
