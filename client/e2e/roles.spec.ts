import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, serverRoom, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Roles Test')
})
test.afterAll(async () => server?.stop())

async function openMember(page: Page, name: string) {
  await page.locator('.member-list').getByRole('button', { name }).first().click()
  await page.getByRole('dialog', { name: `Profile of ${name}` }).getByRole('button', { name: 'More' }).click()
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog).toBeVisible()
  return dialog
}

const roleNames = (page: Page) => page.locator('.role-list .role-name')

test('custom roles: create, reorder, assign, moderate without admin, channel permissions', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const mod = await (await browser.newContext()).newPage()
  await joinVia(mod, await createInviteLink(host), 'Mira')
  const member = await (await browser.newContext()).newPage()
  await joinVia(member, await createInviteLink(host), 'Sam')

  // ── The owner makes a Moderator role from the preset.
  await openServerSettings(host, 'Roles')
  const settings = serverRoom(host, 'Roles Test')
  await settings.getByRole('button', { name: 'Create role' }).click()
  let editor = settings.getByRole('group', { name: 'Edit New role' })
  await editor.getByLabel('Role name').fill('Moderator')
  await editor.getByLabel('Role icon emoji').fill('🛡️')
  await editor.getByLabel('Role colour').fill('#3ba55c')
  await editor.getByText('Show people with this role separately').click()
  await editor.getByRole('button', { name: 'Moderator preset' }).click()
  await expect(editor.getByRole('checkbox', { name: /Ban members/ })).toBeChecked()
  await editor.getByRole('button', { name: 'Save role' }).click()
  await expect(roleNames(host)).toHaveText(['Moderator'])

  await settings.getByRole('button', { name: 'Create role' }).click()
  editor = settings.getByRole('group', { name: 'Edit New role' })
  await editor.getByLabel('Role name').fill('Supporter')
  await editor.getByRole('button', { name: 'Save role' }).click()
  await expect(roleNames(host)).toHaveText(['Moderator', 'Supporter'])

  // Drag to reorder (and back with the arrow buttons).
  await host.locator('.role-row', { hasText: 'Supporter' }).dragTo(host.locator('.role-row', { hasText: 'Moderator' }))
  await expect(roleNames(host)).toHaveText(['Supporter', 'Moderator'])
  await host.getByRole('button', { name: 'Move Supporter down' }).click()
  await expect(roleNames(host)).toHaveText(['Moderator', 'Supporter'])
  await host.screenshot({ path: join(SHOTS, 'roles-settings.png') })
  await host.keyboard.press('Escape')

  // ── Give Mira the role: coloured, grouped, with chips.
  let dialog = await openMember(host, 'Mira')
  await dialog.getByRole('checkbox', { name: 'Moderator' }).click() // saved at once; checked when the server confirms
  await expect(dialog.getByRole('checkbox', { name: 'Moderator' })).toBeChecked()
  await expect(dialog.locator('.role-chips')).toContainText('Moderator')
  await host.keyboard.press('Escape')
  const group = host.locator('.member-list section', { hasText: 'Moderator — 1' })
  await expect(group).toContainText('Mira')
  await expect(group.locator('.member-name', { hasText: 'Mira' })).toHaveCSS('color', 'rgb(59, 165, 92)')
  await host.screenshot({ path: join(SHOTS, 'roles-member-list.png') })
  dialog = await openMember(host, 'Sam')
  await dialog.getByRole('checkbox', { name: 'Supporter' }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Supporter' })).toBeChecked()
  await host.keyboard.press('Escape')

  // ── Mira moderates without being an admin.
  const nav = (await openServerSettings(mod)).getByRole('navigation', { name: 'Settings sections' })
  await expect(nav.getByRole('button', { name: 'Roles' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Activity log' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Internet access' })).toHaveCount(0)
  await expect(nav.getByRole('button', { name: 'Overview' })).toHaveCount(0)
  await mod.keyboard.press('Escape')
  dialog = await openMember(mod, 'Sam')
  await expect(dialog.getByRole('button', { name: 'Kick' })).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Supporter' })).toBeEnabled()
  await expect(dialog.getByRole('checkbox', { name: 'Moderator' })).toBeDisabled() // her own role
  await expect(dialog.getByLabel('Level')).toHaveCount(0) // levels stay with admins
  await mod.screenshot({ path: join(SHOTS, 'roles-moderator-dialog.png') })
  await mod.keyboard.press('Escape')
  dialog = await openMember(mod, 'Host')
  await expect(dialog.getByRole('button', { name: 'Kick' })).toHaveCount(0)
  await mod.keyboard.press('Escape')

  // ── Channel permissions: Supporters can't send in #general.
  await mod.getByRole('button', { name: 'Channel settings' }).click()
  const channelSettings = mod.getByRole('dialog', { name: '#general settings' })
  await channelSettings.getByLabel('Add a role').selectOption({ label: 'Supporter' })
  await channelSettings.getByRole('radiogroup', { name: 'Send messages for Supporter' }).getByRole('radio', { name: 'Deny' }).click()
  await expect(channelSettings.getByRole('radiogroup', { name: 'Send messages for Supporter' }).getByRole('radio', { name: 'Deny' }))
    .toHaveAttribute('aria-checked', 'true')
  await mod.screenshot({ path: join(SHOTS, 'roles-channel-permissions.png') })
  await mod.keyboard.press('Escape')
  await expect(member.getByText("You can't send messages in this channel.")).toBeVisible()

  // The audit log tells the story.
  await openServerSettings(mod, 'Activity log')
  const log = mod.locator('.audit-list')
  await expect(log).toContainText('Mira changed what Supporter can do in #general')
  await expect(log).toContainText('Host gave Mira Moderator')
  await expect(log).toContainText('Host edited the role Moderator')

  // ── @Role mentions: autocomplete, then highlighted for the role's members.
  await mod.keyboard.press('Escape')
  const box = host.getByPlaceholder('Message #general')
  await box.fill('@Mod')
  const option = host.getByRole('listbox', { name: 'Mention someone' }).getByRole('option', { name: /Moderator/ })
  await expect(option).toContainText('role')
  await box.press('Enter')
  await expect(box).toHaveValue('@Moderator ')
  await box.pressSequentially('can someone look?')
  await box.press('Enter')
  await expect(mod.locator('.mention.role-mention.me', { hasText: '@Moderator' })).toBeVisible()
  await expect(member.locator('.mention.role-mention', { hasText: '@Moderator' })).toBeVisible()
  await expect(member.locator('.mention.role-mention.me')).toHaveCount(0)
  await mod.screenshot({ path: join(SHOTS, 'roles-mention.png') })

  // Phone width: the roles list still fits.
  await host.setViewportSize({ width: 390, height: 844 })
  await host.getByRole('button', { name: 'Open channels' }).click()
  await openServerSettings(host, 'Roles')
  await host.locator('.role-pick', { hasText: 'Moderator' }).click()
  await expect(host.getByRole('group', { name: 'Edit Moderator' })).toBeVisible()
  await host.waitForTimeout(400)
  await host.screenshot({ path: join(SHOTS, 'roles-phone.png') })
})
