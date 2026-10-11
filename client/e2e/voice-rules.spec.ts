import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Rules Test')
})
test.afterAll(async () => server?.stop())

test('server rules: new members agree first; voice channels show their user limit', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)

  // ── The owner writes rules and asks new members to agree.
  await openSettings(host, 'Rules')
  const section = host.getByTestId('rules-section')
  await section.getByLabel('Welcome message').fill('Welcome to the crew!')
  await section.getByLabel('Rules').fill('1. **Be kind.**\n2. No spam.\n3. Spoilers go in ||spoiler tags||.')
  await section.getByRole('radio', { name: 'Preview' }).click()
  await expect(section.locator('.rules-preview strong', { hasText: 'Be kind.' })).toBeVisible()
  await section.getByRole('checkbox', { name: /Members must agree/ }).check()
  await expect(section.getByRole('checkbox', { name: /People already here must agree too/ })).toBeChecked()
  await host.screenshot({ path: join(SHOTS, 'rules-settings.png') })
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(section.getByRole('status')).toHaveText('Saved.')
  await expect(section.getByTestId('rules-agreed-count')).toHaveText('0 of 0 members have agreed to the current rules.')
  await host.keyboard.press('Escape')
  await expect(host.getByRole('button', { name: 'Server rules', exact: true })).toBeVisible()

  // ── A friend joins on a phone: the welcome screen comes up by itself.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, invite, 'Friend')
  const welcome = phone.getByRole('dialog', { name: 'Welcome to Rules Test' })
  await expect(welcome).toBeVisible()
  await expect(welcome.getByText('Welcome to the crew!')).toBeVisible()
  await expect(welcome.locator('.rules-text strong', { hasText: 'Be kind.' })).toBeVisible()
  await phone.screenshot({ path: join(SHOTS, 'rules-welcome-phone.png') })

  // Not now: reading works, writing waits.
  await welcome.getByRole('button', { name: 'Not now' }).click()
  await expect(welcome).toHaveCount(0)
  const bar = phone.locator('.rules-bar')
  await expect(bar).toContainText('Agree to the server rules')
  await expect(phone.getByPlaceholder('Message #general')).toHaveCount(0)
  await phone.screenshot({ path: join(SHOTS, 'rules-bar-phone.png') })

  await bar.getByRole('button', { name: 'Read the rules' }).click()
  await phone.getByTestId('rules-agree').click()
  await expect(phone.getByRole('dialog', { name: 'Welcome to Rules Test' })).toHaveCount(0)
  await send(phone, 'hi, I read the rules')
  await expect(host.locator('.message-text', { hasText: 'hi, I read the rules' })).toBeVisible()

  // ── Ask everyone again after a real change.
  await openSettings(host, 'Rules')
  await section.getByRole('radio', { name: 'Write' }).click()
  await section.getByLabel('Rules').fill('1. **Be kind.**\n2. No spam.\n3. No spoilers at all.')
  await section.getByRole('checkbox', { name: /Ask everyone to agree again/ }).check()
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(section.getByRole('status')).toHaveText('Saved.')
  await host.keyboard.press('Escape')
  await expect(phone.locator('.rules-bar')).toBeVisible()
  await expect(phone.getByRole('dialog', { name: 'Welcome to Rules Test' })).toBeVisible()
  await phone.getByTestId('rules-agree').click()
  await expect(phone.getByPlaceholder('Message #general')).toBeVisible()

  // ── Voice channel with a user limit: "0/2" in the channel list for everyone.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Voice' }).click()
  await create.getByPlaceholder('game-night').fill('duo')
  await create.getByRole('button', { name: 'Create' }).click()
  const row = host.locator('.org-row', { has: host.getByRole('button', { name: 'duo', exact: true }) })
  await row.hover()
  await row.getByRole('button', { name: 'duo options' }).click()
  await host.getByRole('menuitem', { name: 'Edit channel' }).click()
  const settings = host.getByRole('dialog', { name: 'duo settings' })
  await settings.getByLabel('User limit').fill('2')
  await expect(settings.getByText('User limit · 2 people')).toBeVisible()
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(host.locator('.voice-limit', { hasText: '0/2' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'voice-user-limit.png') })

  // And the rules stay one click away in the server menu.
  await host.getByRole('button', { name: 'Server rules', exact: true }).click()
  await expect(host.getByRole('dialog', { name: 'Rules Test rules' }).locator('.rules-text')).toContainText('No spoilers at all.')
})
