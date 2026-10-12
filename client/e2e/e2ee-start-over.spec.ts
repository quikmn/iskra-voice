import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, SHOTS, serverRoom, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeEach(async () => {
  server = await startServer('Start Over')
})
test.afterEach(async () => server?.stop())

async function openMember(page: Page, name: string) {
  await page.locator('.member-list').getByRole('button', { name }).first().click()
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

async function setRole(page: Page, name: string, role: string, on: boolean) {
  let dialog
  if (name === 'Host') {
    // Your own roles: from the members list in server settings.
    await openServerSettings(page, 'Members')
    await serverRoom(page, 'Start Over').locator('.room-member', { hasText: name }).click()
    dialog = page.getByRole('dialog', { name })
    await expect(dialog).toBeVisible()
  } else dialog = await openMember(page, name)
  const box = dialog.getByRole('checkbox', { name: role })
  await box.click()
  await expect(box).toBeChecked({ checked: on })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
}

const channelRow = (page: Page, name: string) => page.locator('.channel', { hasText: name })
const membersInPanel = async (page: Page, count: number) => {
  await page.getByTestId('e2ee-panel-open').click()
  const panel = page.getByRole('dialog', { name: 'Encryption' })
  await expect(panel.getByTestId('e2ee-members').locator('li')).toHaveCount(count, { timeout: 20_000 })
  await page.keyboard.press('Escape')
}

async function say(page: Page, text: string) {
  const box = page.getByPlaceholder('Message #vault')
  await box.fill(text)
  await box.press('Enter')
}

test('encrypted channel started over: a returning member sees a warning, starts over by hand, reads old and new messages', async ({ browser }) => {
  test.setTimeout(240_000)
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

  // A role that hides the channel (so even the owner can lose access).
  await openServerSettings(host, 'Roles')
  const settings = serverRoom(host, 'Start Over')
  await settings.getByRole('button', { name: 'Create role' }).click()
  const editor = settings.getByRole('group', { name: 'Edit New role' })
  await editor.getByLabel('Role name').fill('Away')
  await editor.getByRole('button', { name: 'Save role' }).click()
  await host.keyboard.press('Escape')

  // Host, Bob and Carol share an encrypted channel.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByPlaceholder('game-night').fill('vault')
  await create.getByLabel('Who can see it').selectOption('trusted')
  await create.getByTestId('e2ee-toggle').check()
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'vault' })).toBeVisible()
  const before = 'old secret from before: 4417'
  await say(host, before)
  await channelRow(bob, 'vault').click()
  await expect(bob.locator('.message-text', { hasText: before })).toBeVisible({ timeout: 20_000 })

  await host.getByRole('button', { name: 'Channel settings' }).click()
  const channelSettings = host.getByRole('dialog', { name: '#vault settings' })
  await channelSettings.getByLabel('Add a role').selectOption({ label: 'Away' })
  await channelSettings.getByRole('radiogroup', { name: 'See the channel for Away' }).getByRole('radio', { name: 'Deny' }).click()
  await expect(channelSettings.getByRole('radiogroup', { name: 'See the channel for Away' }).getByRole('radio', { name: 'Deny' }))
    .toHaveAttribute('aria-checked', 'true')
  await host.keyboard.press('Escape')

  // Everyone in the chain loses access: Bob and Carol first (Host's app removes them), then Host.
  await setRole(host, 'Bob', 'Away', true)
  await expect(channelRow(bob, 'vault')).toHaveCount(0)
  await membersInPanel(host, 2)
  await setRole(host, 'Carol', 'Away', true)
  await expect(channelRow(carol, 'vault')).toHaveCount(0)
  await membersInPanel(host, 1)
  await setRole(host, 'Host', 'Away', true)
  await expect(channelRow(host, 'vault')).toHaveCount(0)

  // Dave can read it now, and nobody in the chain can: Dave's app starts the encryption over.
  await setLevel(host, 'Dave', 'trusted')
  await channelRow(dave, 'vault').click()
  await expect(dave.getByPlaceholder('Message #vault')).toBeVisible({ timeout: 20_000 })
  await expect(dave.locator('[data-testid="e2ee-unreadable"]').first()).toBeVisible()

  // Bob gets access back. Dave's app adds him to the new chain, but Bob's app never switches by itself.
  await setRole(host, 'Bob', 'Away', false)
  await channelRow(bob, 'vault').click()
  const block = bob.getByTestId('e2ee-waiting')
  await expect(block).toContainText('started its encryption over', { timeout: 20_000 })
  await expect(bob.locator('.message-text', { hasText: before })).toBeVisible()
  await expect(bob.getByPlaceholder('Message #vault')).toHaveCount(0)

  await block.getByTestId('e2ee-review').click()
  const panel = bob.getByRole('dialog', { name: 'Encryption' })
  const offer = panel.getByTestId('e2ee-start-over')
  await expect(offer.getByTestId('e2ee-signers')).toContainText('Dave')
  await expect(offer.getByTestId('e2ee-signers')).toContainText('new to you')
  await expect(offer).toContainText('Who can read it now: Dave, you', { timeout: 20_000 })
  const start = offer.getByRole('button', { name: 'Start over' })
  await expect(start).toBeDisabled() // until Bob says he compared safety numbers with Dave
  await bob.waitForTimeout(300)
  await bob.screenshot({ path: join(SHOTS, 'e2ee-start-over.png') })
  await offer.getByRole('checkbox', { name: 'I compared safety numbers with the people who signed it' }).check()
  await start.click()
  await expect(offer).toHaveCount(0, { timeout: 20_000 })
  // The panel lists it under History (it opened from the composer, which is back now).
  if (await panel.count()) await bob.keyboard.press('Escape')
  await bob.getByTestId('e2ee-panel-open').click()
  await expect(panel.getByTestId('e2ee-history')).toContainText('You started encryption over on')
  await bob.keyboard.press('Escape')

  // Bob reads and writes again; old messages stay readable; the channel shows the record.
  await expect(bob.getByTestId('e2ee-record')).toContainText('You started encryption over on')
  await expect(bob.locator('.message-text', { hasText: before })).toBeVisible()
  await expect(bob.getByPlaceholder('Message #vault')).toBeVisible({ timeout: 20_000 })
  await say(bob, 'back in the vault')
  await expect(dave.locator('.message-text', { hasText: 'back in the vault' })).toBeVisible({ timeout: 20_000 })
  await say(dave, 'welcome back, Bob')
  await expect(bob.locator('.message-text', { hasText: 'welcome back, Bob' })).toBeVisible({ timeout: 20_000 })

  await bob.setViewportSize({ width: 390, height: 844 })
  await bob.waitForTimeout(500)
  await bob.screenshot({ path: join(SHOTS, 'e2ee-start-over-done-phone.png') })
})
