import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Mentions Test')
})
test.afterAll(async () => server?.stop())

test('mention someone with autocomplete, with formatting', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // The host is looking at another channel when the mention arrives.
  await host.getByRole('button', { name: 'Create channel' }).click()
  await host.getByLabel('Name').fill('off-topic')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(host.getByRole('heading', { name: 'off-topic' })).toBeVisible()

  const box = friend.getByPlaceholder('Message #general')
  await box.pressSequentially('hey @Ho')
  await expect(friend.locator('.mention-popup')).toContainText('Host')
  await box.press('Enter') // picks the suggestion
  await box.pressSequentially('**game tonight?** ||spoilers|| `code`')
  await box.press('Enter')

  // A red mention badge on #general for the host.
  await expect(host.locator('.channel', { hasText: 'general' }).locator('.badge')).toHaveText('1')
  await expect(host).toHaveTitle('(1) Iskra')
  await host.locator('.channel', { hasText: 'general' }).click()
  await expect(host).toHaveTitle('Iskra')

  const message = host.locator('.message', { hasText: 'game tonight' })
  await expect(message.locator('.mention.me')).toHaveText('@Host')
  await expect(message.locator('strong')).toHaveText('game tonight?')
  await expect(message.locator('code')).toHaveText('code')
  await expect(message.locator('.spoiler')).not.toHaveClass(/shown/)
  await message.locator('.spoiler').click()
  await expect(message.locator('.spoiler')).toHaveClass(/shown/)
  await host.screenshot({ path: join(SHOTS, 'mentions.png') })
})
