import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, send, serverRoom, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('AutoMod Test')
})
test.afterAll(async () => server?.stop())

test('AutoMod blocks a word, tells the sender why, alerts and audits', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── Settings → AutoMod: off at first, then words with an alert in #general.
  await openServerSettings(host, 'AutoMod (auto-moderation)')
  const section = host.getByTestId('automod-section')
  await expect(section).toContainText('AutoMod is off')
  await expect(section).toContainText("the server can't read them")
  await section.getByRole('switch', { name: 'AutoMod' }).click()
  await section.getByRole('button', { name: 'Use suggested settings' }).click()
  const words = section.locator('.automod-rule', { hasText: 'Blocked words' })
  await words.getByRole('switch', { name: 'Blocked words' }).click()
  await words.getByLabel('Blocked words and phrases').fill('badword\nspam*')
  await section.getByLabel('Alert channel').selectOption({ label: '#general' })
  await words.getByLabel('Send an alert').check()
  await expect(section).toContainText('You have unsaved changes.')
  await host.screenshot({ path: join(SHOTS, 'automod-settings.png') })
  await section.getByRole('button', { name: 'Save changes' }).click()
  await expect(section.getByRole('status')).toHaveText('Saved.')
  await expect(section).toContainText('AutoMod is on')
  await host.keyboard.press('Escape')

  // ── The friend's message never arrives; they see why and can take it back to edit.
  await send(friend, 'this is ＢＡＤＷＯＲＤ honestly')
  const failed = friend.locator('.message-failed')
  await expect(failed).toContainText("Blocked by AutoMod: it contains a word that isn't allowed on this server.")
  await friend.screenshot({ path: join(SHOTS, 'automod-blocked-sender.png') })
  await failed.getByRole('button', { name: 'Edit' }).click()
  await expect(friend.getByPlaceholder('Message #general')).toHaveValue('this is ＢＡＤＷＯＲＤ honestly')
  await expect(friend.locator('.message-failed')).toHaveCount(0)
  await friend.getByPlaceholder('Message #general').fill('')

  // Fine messages still go through.
  await send(friend, 'a perfectly nice message')
  await expect(host.locator('.message-text', { hasText: 'a perfectly nice message' })).toBeVisible()

  // ── The alert: who, where and the rule, with the word masked and hidden until clicked.
  const alert = host.getByTestId('automod-alert')
  await expect(alert).toContainText('Blocked a message from Friend in #general')
  await expect(host.locator('.message', { has: alert }).locator('.author')).toHaveText('AutoMod')
  await expect(host.getByText('ＢＡＤＷＯＲＤ')).toHaveCount(0)
  await alert.getByRole('button', { name: 'Spoiler, click to reveal' }).click()
  await expect(alert).toContainText('this is Ｂ••• honestly')
  await host.screenshot({ path: join(SHOTS, 'automod-alert.png') })

  // ── The audit log has it.
  await openServerSettings(host, 'Activity log')
  await expect(serverRoom(host)).toContainText('AutoMod blocked a message by Friend in #general (blocked word)')
  await expect(serverRoom(host)).toContainText('Host changed the AutoMod settings')
  await host.keyboard.press('Escape')

  // ── Phone width: the settings stay usable.
  await host.setViewportSize({ width: 390, height: 844 })
  await host.getByRole('button', { name: 'Open channels' }).click()
  await openServerSettings(host, 'AutoMod (auto-moderation)')
  await expect(host.getByTestId('automod-section')).toContainText('AutoMod is on')
  await host.screenshot({ path: join(SHOTS, 'automod-settings-phone.png') })
})
