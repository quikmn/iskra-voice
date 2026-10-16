import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, serverRoom, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Onboarding Test')
})
test.afterAll(async () => server?.stop())

/** Settings → Roles: a new role members may pick themselves. */
async function makePickableRole(page: Page, name: string) {
  const settings = serverRoom(page, 'Onboarding Test')
  await settings.getByRole('button', { name: 'Create role' }).click()
  const editor = settings.getByRole('group', { name: 'Edit New role' })
  await editor.getByLabel('Role name').fill(name)
  await editor.getByRole('checkbox', { name: /Members can pick this role themselves/ }).check()
  await editor.getByRole('button', { name: 'Save role' }).click()
  await expect(settings.locator('.role-list .role-name', { hasText: name })).toBeVisible()
}

test('self-assignable roles: admins ask, new members pick after the rules, everyone can change their picks', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)

  // ── Roles members may pick. The flag and permissions lock each other out.
  await openServerSettings(host, 'Roles')
  for (const name of ['PC', 'PlayStation', 'Event pings']) await makePickableRole(host, name)
  const settings = serverRoom(host, 'Onboarding Test')
  await settings.locator('.role-pick', { hasText: 'PC' }).click()
  const editor = settings.getByRole('group', { name: 'Edit PC' })
  await expect(editor.getByRole('checkbox', { name: /Kick members/ })).toBeDisabled()
  await expect(editor.getByText(/Members pick this role themselves, so it can.t have permissions/)).toBeVisible()

  // ── Onboarding: a single-choice question and a multi-choice one.
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Onboarding', exact: true }).click()
  const onboarding = host.getByTestId('onboarding-section')
  await onboarding.getByRole('button', { name: 'Add a question' }).click()
  let form = onboarding.getByRole('group', { name: 'Add a question' })
  await form.getByLabel('Title').fill('Platform')
  await form.getByLabel('Question (optional)').fill('What do you play on?')
  await form.getByRole('checkbox', { name: 'PC' }).check()
  await form.getByRole('checkbox', { name: 'PlayStation' }).check()
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(onboarding.locator('.onboarding-row', { hasText: 'Platform' })).toContainText('One answer · PC, PlayStation')
  await onboarding.getByRole('button', { name: 'Add a question' }).click()
  form = onboarding.getByRole('group', { name: 'Add a question' })
  await form.getByLabel('Title').fill('Pings')
  await form.getByRole('radio', { name: 'Several answers' }).click()
  await form.getByRole('checkbox', { name: 'Event pings' }).check()
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(onboarding.locator('.onboarding-row', { hasText: 'Pings' })).toContainText('Several answers · Event pings')
  await host.screenshot({ path: join(SHOTS, 'onboarding-settings.png') })

  // ── Rules that must be agreed to, so the welcome screen comes up for newcomers.
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Server rules', exact: true }).click()
  const rules = host.getByTestId('rules-section')
  await rules.getByLabel('Rules').fill('1. Be kind.')
  await rules.getByRole('checkbox', { name: /Members must agree/ }).check()
  await rules.getByRole('button', { name: 'Save' }).click()
  await expect(rules.getByRole('status')).toHaveText('Saved.')
  await host.keyboard.press('Escape')

  // ── A friend joins on a phone: agree, then pick.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, invite, 'Sam')
  const welcome = phone.getByRole('dialog', { name: 'Welcome to Onboarding Test' })
  await expect(welcome).toBeVisible()
  await phone.getByTestId('rules-agree').click()
  const picker = phone.getByRole('dialog', { name: 'Pick your roles' })
  await expect(picker).toBeVisible()
  await expect(picker.getByText('What do you play on?')).toBeVisible()
  await picker.getByRole('checkbox', { name: 'PC' }).click()
  await expect(picker.getByRole('checkbox', { name: 'PC' })).toHaveAttribute('aria-checked', 'true') // when the server says so
  await picker.getByRole('checkbox', { name: 'Event pings' }).click()
  await expect(picker.getByRole('checkbox', { name: 'Event pings' })).toHaveAttribute('aria-checked', 'true')
  await phone.screenshot({ path: join(SHOTS, 'onboarding-picker-phone.png') })
  // One answer only: PlayStation replaces PC.
  await picker.getByRole('checkbox', { name: 'PlayStation' }).click()
  await expect(picker.getByRole('checkbox', { name: 'PlayStation' })).toHaveAttribute('aria-checked', 'true')
  await expect(picker.getByRole('checkbox', { name: 'PC' })).toHaveAttribute('aria-checked', 'false')
  await phone.getByTestId('role-picker-done').click()
  await expect(picker).toHaveCount(0)
  await expect(phone.getByPlaceholder('Message #general')).toBeVisible()

  // The host sees the picks on Sam's profile.
  await host.locator('.member-list').getByRole('button', { name: 'Sam' }).first().click()
  const profile = host.getByRole('dialog', { name: 'Profile of Sam' })
  await expect(profile.locator('.role-chips')).toContainText('PlayStation')
  await expect(profile.locator('.role-chips')).toContainText('Event pings')
  await expect(profile.locator('.role-chips')).not.toContainText('PC')
  await host.keyboard.press('Escape')

  // ── Later: /roles opens the picker again; so does the server menu.
  const box = phone.getByPlaceholder('Message #general')
  await box.fill('/roles')
  await box.press('Enter') // picks the suggestion…
  await expect(box).toHaveValue('/roles ')
  await box.press('Enter') // …and runs it
  const again = phone.getByRole('dialog', { name: 'Pick your roles on Onboarding Test' })
  await expect(again).toBeVisible()
  await again.getByRole('checkbox', { name: 'Event pings' }).click()
  await expect(again.getByRole('checkbox', { name: 'Event pings' })).toHaveAttribute('aria-checked', 'false')
  await phone.getByTestId('role-picker-done').click()
  await expect(box).toHaveValue('')

  await phone.getByRole('button', { name: 'Open channels' }).click()
  await phone.locator('.server-header-button').click()
  await phone.getByRole('menuitem', { name: 'Pick your roles' }).click()
  await expect(phone.getByRole('dialog', { name: 'Pick your roles on Onboarding Test' })).toBeVisible()
  await phone.getByTestId('role-picker-done').click()

  // Picking never lifts anyone: Sam is still a plain member to the host's moderation tools.
  await host.locator('.member-list').getByRole('button', { name: 'Sam' }).first().click()
  await host.getByRole('dialog', { name: 'Profile of Sam' }).getByRole('button', { name: 'More' }).click()
  await expect(host.getByRole('dialog', { name: 'Sam' }).getByRole('button', { name: 'Kick' })).toBeVisible()
})
