import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Builtin Roles')
})
test.afterAll(async () => server?.stop())

test('built-in roles are listed with a badge, what they can do, and the same names the channel picker uses', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Sam')
  await host.locator('.member-list').getByRole('button', { name: 'Sam' }).waitFor()

  // ── Settings → Roles: the built-in roles first, each with the badge and how many hold it.
  const room = await openServerSettings(host, 'Roles')
  const builtin = room.getByRole('list', { name: 'Built-in roles' })
  await expect(builtin.locator('.builtin-role-name')).toHaveText(['Owner', 'Admin', 'Trusted', 'Member', 'Guest'])
  await expect(builtin.locator('.builtin-badge')).toHaveText(Array(5).fill('Built-in'))
  await expect(builtin.locator('[data-base-role="owner"]')).toContainText('1')
  await expect(builtin.locator('[data-base-role="member"]')).toContainText('1')
  await expect(room.getByText('Custom roles', { exact: true })).toBeVisible()
  await expect(room.getByRole('button', { name: 'Create role' })).toBeVisible()

  // What a role can do comes from the server's table.
  await builtin.getByRole('button', { name: /Trusted/ }).click()
  let about = room.getByRole('group', { name: 'About Trusted' })
  await expect(about).toContainText('Everything Member can, plus:')
  await expect(about).toContainText('Pin messages where they can post')
  await expect(about.locator('.builtin-abilities')).not.toContainText('Schedule events') // that comes from Member
  await builtin.getByRole('button', { name: /Admin/ }).click()
  about = room.getByRole('group', { name: 'About Admin' })
  await expect(about).toContainText('Every permission:')
  await expect(about).toContainText('Add bots and let them into voice')

  // The owner gives Admin a colour; it's kept.
  await about.getByLabel('Role colour').fill('#e5534b')
  await about.getByRole('button', { name: 'Save colour' }).click()
  await expect(about.getByRole('status')).toHaveText('Saved')
  await expect(builtin.locator('[data-base-role="admin"] .role-dot')).toHaveCSS('background-color', 'rgb(229, 83, 75)')
  await builtin.scrollIntoViewIfNeeded()
  await host.screenshot({ path: join(SHOTS, 'builtin-roles.png') })

  // Phone width: still one readable column.
  await host.setViewportSize({ width: 390, height: 800 })
  await builtin.locator('[data-base-role="guest"]').scrollIntoViewIfNeeded()
  await expect(builtin.locator('[data-base-role="guest"]')).toBeInViewport()
  await host.waitForTimeout(400) // the page slide
  await host.screenshot({ path: join(SHOTS, 'builtin-roles-phone.png') })
  await host.setViewportSize({ width: 1280, height: 800 })
  const listed = await builtin.locator('.builtin-role-name').allTextContents()
  await host.keyboard.press('Escape')

  // ── The channel picker offers exactly those roles, by the same names.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  const options = (await create.getByLabel('Who can see it').locator('option').allTextContents())
    .map((label) => label.replace(/ and up$/, ''))
  expect(options.length).toBe(5)
  expect([...options].reverse()).toEqual(listed)
  await create.getByLabel('Who can see it').selectOption('trusted')
  await expect(create.getByLabel('Who can post').locator('option')).toHaveText(['Trusted and up', 'Admin and up', 'Owner'])
})
