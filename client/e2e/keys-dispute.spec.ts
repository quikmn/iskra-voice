import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Dispute Test')
})
test.afterAll(async () => server?.stop())

async function recoveryKeyOf(page: Page): Promise<string> {
  await openSettings(page, 'Recovery key')
  await page.getByRole('button', { name: 'Show recovery key' }).click()
  const key = (await page.locator('.recovery-key').innerText()).trim()
  await page.keyboard.press('Escape')
  return key
}

test('someone with a stolen key replaces it first; the owner claims it back and an admin settles the dispute', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, invite, 'Friend')
  await friend.getByPlaceholder('Message #general').fill('the real friend was here')
  await friend.getByPlaceholder('Message #general').press('Enter')

  // A thief restores Friend's account from a leaked recovery key and replaces the key, leaving Friend's device out.
  const leaked = await recoveryKeyOf(friend)
  const thief = await (await browser.newContext()).newPage()
  await thief.goto(invite)
  await agreeToTerms(thief)
  await thief.getByRole('button', { name: /I already use Iskra/ }).click()
  await thief.getByRole('button', { name: /Use my recovery key/ }).click()
  await thief.getByLabel('Recovery key').fill(leaked)
  await thief.getByLabel('Your name').fill('Friend')
  await thief.getByRole('button', { name: 'Restore my account' }).click()
  await expect(thief.getByRole('heading', { name: 'general' })).toBeVisible()
  await openSettings(thief, 'Recovery key')
  await thief.getByRole('button', { name: 'Replace account key' }).click()
  const dialog = thief.getByRole('dialog', { name: 'Replace account key' })
  const keep = dialog.locator('.key-devices input[type=checkbox]')
  await expect(keep).toHaveCount(1) // Friend's own device
  await keep.uncheck()
  await dialog.getByText(/I understand my old recovery key/).click()
  await dialog.getByRole('button', { name: 'Replace key' }).click()
  await thief.getByRole('dialog', { name: 'Your account has a new key' }).getByRole('button', { name: 'Done' }).click()

  // Friend's own device is told at once, and wasn't handed the new key.
  await expect(friend.getByText('Your account key was replaced')).toBeVisible()
  await friend.getByRole('button', { name: "That wasn't me" }).click()
  await friend.screenshot({ path: join(SHOTS, 'keys-claim-back.png') })
  await friend.getByRole('button', { name: 'Take my account back' }).click()
  // Friend gets a new key (and recovery key); this server records a dispute because the thief was first.
  const newKey = friend.getByRole('dialog', { name: 'Your account has a new key' })
  await expect(newKey).toBeVisible()
  await newKey.getByRole('button', { name: 'Done' }).click()
  await expect(friend.locator('.pill.rejected')).toBeVisible()

  // The owner sees the dispute and gives the account to the key Friend confirms is theirs.
  const banner = host.locator('.key-dispute')
  await expect(banner).toContainText("Friend's account is disputed")
  await host.screenshot({ path: join(SHOTS, 'keys-dispute-banner.png') })
  await banner.getByRole('button', { name: /^Give it to / }).click()
  await expect(banner).toHaveCount(0)

  // The thief is signed out and told; Friend comes back as the same member, history included.
  await expect(thief.getByText('Your account key was replaced')).toBeVisible()
  await friend.reload()
  await expect(friend.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(friend.locator('.me-text')).toContainText('member')
  await expect(friend.getByText('the real friend was here')).toBeVisible()
  await friend.getByPlaceholder('Message #general').fill('back with my own key')
  await friend.getByPlaceholder('Message #general').press('Enter')
  await expect(host.getByText('back with my own key')).toBeVisible()
  // Messages from before the change still show Friend's name, not "Former member".
  await expect(host.getByText('Former member')).toHaveCount(0)
})
