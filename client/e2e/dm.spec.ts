import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('DM Test')
})
test.afterAll(async () => server?.stop())

test('friends send end-to-end encrypted DMs the server cannot read', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // The friend opens Host's profile from the member list and starts a DM.
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('button', { name: 'Add friend' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await expect(friend.locator('.e2e-badge')).toBeVisible()

  const secret = 'meet at the usual place 🔐 7731'
  const box = friend.getByPlaceholder('Message Host')
  await box.fill(secret)
  await box.press('Enter')
  await expect(friend.locator('.message-text', { hasText: secret })).toBeVisible()

  // Host sees a badge on Home (the message and the friend request) and reads it.
  await expect(host.locator('.server-icon.home .badge')).toHaveText('2')
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await host.locator('.dm-row', { hasText: 'Friend' }).click()
  await expect(host.locator('.message-text', { hasText: secret })).toBeVisible()

  // Reply goes back the other way.
  await host.getByPlaceholder('Message Friend').fill('see you there')
  await host.getByPlaceholder('Message Friend').press('Enter')
  await expect(friend.locator('.message-text', { hasText: 'see you there' })).toBeVisible()

  // Emoji in a DM: the picker has the standard ones (no server needed).
  await host.getByPlaceholder('Message Friend').fill('great')
  await host.locator('.composer').getByRole('button', { name: 'Emoji' }).click()
  const picker = host.getByRole('dialog', { name: 'Emoji picker' })
  await picker.getByLabel('Search emoji').fill('tada')
  await picker.getByRole('button', { name: ':tada:' }).first().click()
  await expect(picker).toHaveCount(0)
  await expect(host.getByPlaceholder('Message Friend')).toHaveValue('great 🎉')
  await host.getByPlaceholder('Message Friend').press('Enter')
  await expect(friend.locator('.message-text', { hasText: 'great 🎉' })).toBeVisible()

  // Both see the same safety number.
  await host.getByRole('button', { name: 'Verify' }).click()
  await friend.getByRole('button', { name: 'Verify' }).click()
  const hostNumber = await host.locator('.safety-number').innerText()
  expect(hostNumber.replace(/\s+/g, '')).toMatch(/^\d{60}$/)
  expect(await friend.locator('.safety-number').innerText()).toBe(hostNumber)
  await friend.screenshot({ path: join(SHOTS, 'dm-verify.png') })
  await friend.keyboard.press('Escape')
  await friend.screenshot({ path: join(SHOTS, 'dm.png') })

  // The friend request waits in the Friends page until Host answers.
  await friend.locator('.channel', { hasText: 'Friends' }).click()
  await friend.getByRole('tab', { name: 'Pending' }).click()
  await expect(friend.locator('.friend-row', { hasText: 'Host' })).toContainText('Request sent')

  // The server's files never contain the message text.
  for (const file of readdirSync(server.world).filter((f) => f.startsWith('iskra.db'))) {
    const bytes = readFileSync(join(server.world, file))
    expect(bytes.includes(Buffer.from('usual place'))).toBe(false)
    expect(bytes.includes(Buffer.from('see you there'))).toBe(false)
  }
})
