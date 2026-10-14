// Invites that never expire: admins and owners only, clearly marked in the list, and revocable any time.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { agreeToTerms, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Iskra Review')
})
test.afterAll(async () => server?.stop())

test('an owner makes a never-expiring invite, a friend joins with it, and revoking it stops it working', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage()
  await joinVia(alice, server.ownerLink(), 'Alice')

  await alice.getByRole('button', { name: 'Invite friends' }).click()
  const dialog = alice.getByRole('dialog', { name: 'Invite friends to Iskra Review' })
  const link = dialog.locator('.copy-row input')
  await expect(link).toHaveValue(/#\/join\//)
  await dialog.getByTestId('invite-expiry').selectOption({ label: 'Never' })
  await expect(dialog.getByText('This link keeps working until you revoke it.', { exact: false })).toBeVisible()
  const neverRow = dialog.locator('[data-testid="invite-row"][data-never]')
  await expect(neverRow).toHaveCount(1)
  await expect(neverRow).toContainText('Never expires')
  await expect(neverRow).toContainText('This link')
  // The 7-day link made when the dialog opened is listed with its date.
  await expect(dialog.locator('[data-testid="invite-row"]:not([data-never])').first()).toContainText('Expires')
  const neverLink = await link.inputValue()
  expect(neverLink).not.toBe('')
  await alice.screenshot({ path: join(SHOTS, 'invite-never.png') })
  await alice.keyboard.press('Escape')

  // A friend joins with it, as a member, and can't make one himself.
  const bob = await (await browser.newContext()).newPage()
  await joinVia(bob, neverLink, 'Bob')
  await bob.getByRole('button', { name: 'Invite friends' }).click()
  const bobDialog = bob.getByRole('dialog', { name: 'Invite friends to Iskra Review' })
  await expect(bobDialog.locator('.copy-row input')).toHaveValue(/#\/join\//)
  await expect(bobDialog.getByTestId('invite-expiry').locator('option')).toHaveText(['1 hour', '1 day', '7 days', '30 days'])
  // Members see only their own invites.
  await expect(bobDialog.getByTestId('invite-row').first()).toBeVisible()
  await expect(bobDialog.getByTestId('invite-row').filter({ hasText: 'Never expires' })).toHaveCount(0)

  // Alice revokes it; the link stops working.
  await alice.getByRole('button', { name: 'Invite friends' }).click()
  const row = dialog.getByTestId('invite-row').filter({ hasText: 'Never expires' }).filter({ hasText: neverLink.slice(-6) })
  await expect(row).toHaveCount(1)
  // Phone width: the list wraps and stays usable.
  await alice.setViewportSize({ width: 390, height: 844 })
  await expect(row.getByRole('button', { name: /Revoke invite/ })).toBeInViewport()
  await alice.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))
  await alice.screenshot({ path: join(SHOTS, 'invite-list-phone.png') })
  await row.getByRole('button', { name: /Revoke invite/ }).click()
  await expect(dialog.getByTestId('invite-row').filter({ hasText: neverLink.slice(-6) })).toHaveCount(0)

  const carol = await (await browser.newContext()).newPage()
  await carol.goto(neverLink)
  await expect(carol.getByText("You've been invited")).toBeVisible()
  await agreeToTerms(carol)
  await carol.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await carol.getByLabel('Your name').fill('Carol')
  await carol.getByRole('button', { name: 'Join' }).click()
  await expect(carol.getByText('You need a valid invite to join this server.')).toBeVisible({ timeout: 15_000 })
})
