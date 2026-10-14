import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Roles Templates')
})
test.afterAll(async () => server?.stop())

test('the owner adjusts what Member can do, resets it, and saves the server as a template', async ({ browser }) => {
  const host = await (await browser.newContext({ acceptDownloads: true })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Sam')
  await host.locator('.member-list').getByRole('button', { name: 'Sam' }).waitFor()
  const invite = friend.locator('.invite-button')
  await expect(invite).toBeVisible() // members invite by default

  // ── Settings → Roles → Member: everyday powers only, the owner's role never changes.
  const room = await openServerSettings(host, 'Roles')
  const builtin = room.getByRole('list', { name: 'Built-in roles' })
  await builtin.getByRole('button', { name: /Owner/ }).click()
  await expect(room.getByRole('group', { name: 'About Owner' })).toContainText('The owner can always do everything')
  await expect(room.getByRole('group', { name: 'About Owner' }).locator('input[type=checkbox]')).toHaveCount(0)

  await builtin.getByRole('button', { name: /Member/ }).click()
  const about = room.getByRole('group', { name: 'About Member' })
  const powers = about.getByRole('group', { name: 'What Member can do' })
  await expect(powers.locator('input[type=checkbox]')).toHaveCount(5) // everyday powers only
  await expect(powers.locator('[data-permission="kickMembers"]')).toHaveCount(0)
  await powers.locator('[data-ability="invite"]').uncheck()
  await powers.locator('[data-ability="pin"]').check()
  await powers.getByRole('button', { name: 'Save powers' }).click()
  await expect(powers.getByRole('status')).toHaveText('Saved')
  await expect(builtin.locator('[data-base-role="member"] .builtin-changed')).toHaveText('Changed')
  await expect(about).toContainText('Pin messages where they can post')
  await expect(about.getByTestId('base-role-changed')).toContainText('1 added, 1 taken away')
  // Sam's app follows at once: no invite button any more.
  await expect(invite).toHaveCount(0)
  await builtin.scrollIntoViewIfNeeded()
  await host.screenshot({ path: join(SHOTS, 'builtin-role-powers.png') })

  // Phone width: the ticks stay one readable column.
  await host.setViewportSize({ width: 390, height: 800 })
  await powers.scrollIntoViewIfNeeded()
  await expect(powers.getByRole('button', { name: 'Reset to default' })).toBeVisible()
  await host.waitForTimeout(400)
  await host.screenshot({ path: join(SHOTS, 'builtin-role-powers-phone.png') })
  await host.setViewportSize({ width: 1280, height: 800 })

  // Reset to default: back as before, and Sam can invite again.
  await powers.getByRole('button', { name: 'Reset to default' }).click()
  await expect(builtin.locator('[data-base-role="member"] .builtin-changed')).toHaveCount(0)
  await expect(invite).toBeVisible()

  // ── Overview → Save as template: a file with the setup, nothing about people.
  await room.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Overview', exact: true }).click()
  const save = room.getByTestId('save-template')
  await expect(save).toContainText('Never members, messages, files or keys')
  const [download] = await Promise.all([host.waitForEvent('download'), save.getByRole('button', { name: 'Save as template' }).click()])
  expect(download.suggestedFilename()).toBe('roles-templates.iskra-template.json')
  const json = readFileSync((await download.path())!, 'utf8')
  const template = JSON.parse(json) as { version: number; name: string; channels?: { name: string }[]; categories?: { channels: { name: string }[] }[] }
  expect(template.version).toBe(2)
  expect(template.name).toBe('Roles Templates')
  const names = [...(template.channels ?? []), ...(template.categories ?? []).flatMap((c) => c.channels)].map((c) => c.name)
  expect(names).toContain('general')
  expect(json).not.toContain('Sam')
  expect(json).not.toContain('Host')
  await expect(save.getByRole('status')).toHaveText('Saved.')
  await save.scrollIntoViewIfNeeded()
  await host.screenshot({ path: join(SHOTS, 'save-as-template.png') })

})
