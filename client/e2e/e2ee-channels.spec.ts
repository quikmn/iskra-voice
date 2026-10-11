import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeEach(async () => {
  server = await startServer('E2EE Channels')
})
test.afterEach(async () => server?.stop())

async function openMember(page: Page, name: string) {
  await page.locator('.member-list').getByRole('button', { name }).click()
  await page.getByRole('dialog', { name: `Profile of ${name}` }).getByRole('button', { name: 'More' }).click()
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog).toBeVisible()
  return dialog
}

async function setLevel(page: Page, name: string, level: string) {
  const dialog = await openMember(page, name)
  await dialog.getByLabel('Level').selectOption(level)
  await expect(dialog.getByLabel('Level')).toHaveValue(level)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
}

const channelRow = (page: Page, name: string) => page.locator('.channel', { hasText: name })

async function say(page: Page, text: string) {
  const box = page.getByPlaceholder('Message #vault')
  await box.fill(text)
  await box.press('Enter')
}

test('encrypted channels: members chat, a removed member gets a new key cut off, the server stores no plaintext', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const link = await createInviteLink(host)
  const [bob, carol, dave] = await Promise.all(['Bob', 'Carol', 'Dave'].map(async (name) => {
    const page = await (await browser.newContext()).newPage()
    await joinVia(page, link, name)
    return page
  }))
  await host.locator('.member-list').getByRole('button', { name: 'Dave' }).waitFor()
  await setLevel(host, 'Bob', 'trusted')
  await setLevel(host, 'Carol', 'trusted')

  // The owner makes an encrypted channel only trusted people (and up) can see: Host, Bob and Carol.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByPlaceholder('game-night').fill('vault')
  await create.getByLabel('Who can see it').selectOption('trusted')
  await create.getByTestId('e2ee-toggle').check()
  await expect(create).toContainText('3 people will be able to read it.')
  await expect(create).toContainText("New members can't read messages from before they joined")
  await host.waitForTimeout(300)
  await host.screenshot({ path: join(SHOTS, 'e2ee-create.png') })
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'vault' })).toBeVisible()
  await expect(channelRow(host, 'vault').getByTestId('e2ee-lock')).toBeVisible()

  const secret = 'the vault code is 7781'
  await say(host, secret)
  await expect(host.locator('.message-text', { hasText: secret })).toBeVisible()

  // Bob and Carol read it on their own devices; Dave doesn't even see the channel.
  for (const page of [bob, carol]) {
    await channelRow(page, 'vault').click()
    await expect(page.locator('.message-text', { hasText: secret })).toBeVisible({ timeout: 20_000 })
  }
  await expect(channelRow(dave, 'vault')).toHaveCount(0)
  await say(bob, 'got it, see you at 8')
  await expect(host.locator('.message-text', { hasText: 'got it, see you at 8' })).toBeVisible()
  await expect(carol.locator('.message-text', { hasText: 'got it, see you at 8' })).toBeVisible()
  await say(carol, 'bringing snacks')
  await expect(bob.locator('.message-text', { hasText: 'bringing snacks' })).toBeVisible()

  // Search runs on the device for encrypted channels (the server can't read them).
  const box = bob.getByRole('searchbox', { name: 'Search messages' }).first()
  await box.fill('snacks')
  await box.press('Enter')
  await expect(bob.locator('.search-panel .result-card')).toHaveCount(1)
  await expect(bob.locator('.search-panel')).toContainText('searched on this device only')
  await bob.keyboard.press('Escape')

  // The encryption panel lists who holds the key.
  await host.getByTestId('e2ee-panel-open').click()
  const panel = host.getByRole('dialog', { name: 'Encryption' })
  await expect(panel.getByTestId('e2ee-members').locator('li')).toHaveCount(3)
  await host.waitForTimeout(400)
  await host.screenshot({ path: join(SHOTS, 'e2ee-panel.png') })
  await host.keyboard.press('Escape')

  // Carol loses access: the members' apps remove her and hand out a new key without her.
  await setLevel(host, 'Carol', 'member')
  await expect(channelRow(carol, 'vault')).toHaveCount(0)
  await host.getByTestId('e2ee-panel-open').click()
  await expect(panel.getByTestId('e2ee-members').locator('li')).toHaveCount(2, { timeout: 20_000 })
  await expect(panel).toContainText('Key version 2')
  await host.keyboard.press('Escape')

  const after = 'new code after carol left: 9902'
  await say(host, after)
  await expect(bob.locator('.message-text', { hasText: after })).toBeVisible({ timeout: 20_000 })
  await expect(carol.getByText(after)).toHaveCount(0)

  // On a phone.
  await bob.setViewportSize({ width: 390, height: 844 })
  await expect(bob.locator('.message-text', { hasText: after })).toBeVisible()
  await bob.waitForTimeout(600)
  await bob.screenshot({ path: join(SHOTS, 'e2ee-channel-phone.png') })
  await host.screenshot({ path: join(SHOTS, 'e2ee-channel.png') })

  // The server's database holds only ciphertext: none of what was said.
  for (const file of readdirSync(server.world).filter((f) => f.startsWith('iskra.db'))) {
    const bytes = readFileSync(join(server.world, file))
    for (const text of ['7781', 'see you at 8', 'bringing snacks', '9902']) expect(bytes.includes(Buffer.from(text))).toBe(false)
  }
})
