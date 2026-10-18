import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, serverRoom, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Join Test')
})
test.afterAll(async () => server?.stop())

/** Settings → Roles: a new role members may pick themselves. */
async function makePickableRole(page: Page, name: string) {
  const settings = serverRoom(page, 'Join Test')
  await settings.getByRole('button', { name: 'Create role' }).click()
  const editor = settings.getByRole('group', { name: 'Edit New role' })
  await editor.getByLabel('Role name').fill(name)
  await editor.getByRole('checkbox', { name: /Members can pick this role themselves/ }).check()
  await editor.getByRole('button', { name: 'Save role' }).click()
  await expect(settings.locator('.role-list .role-name', { hasText: name })).toBeVisible()
}

/** Opens someone's profile from the member list: their role chips. */
async function rolesOf(host: Page, name: string) {
  await host.locator('.member-list').getByRole('button', { name }).first().click()
  return host.getByRole('dialog', { name: `Profile of ${name}` }).locator('.role-chips')
}

test('join questions: admins ask, newcomers answer step by step, answers give roles and suggest channels', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)

  // ── Roles members may pick (the only kind answers and roles on join can give).
  await openServerSettings(host, 'Roles')
  for (const name of ['PC', 'PlayStation', 'Event pings', 'Newcomer']) await makePickableRole(host, name)
  const settings = serverRoom(host, 'Join Test')

  // ── Join questions: a required single-choice question with labelled answers, and an optional multi-choice one.
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Join questions', exact: true }).click()
  const section = host.getByTestId('onboarding-section')
  await section.getByRole('button', { name: 'Add a question' }).click()
  let form = section.getByRole('group', { name: 'Add a question' })
  await form.getByLabel('Title').fill('Platform')
  await form.getByLabel('Question (optional)').fill('What do you play on?')
  await form.getByRole('checkbox', { name: /Required/ }).check()
  let answer = form.getByRole('group', { name: 'Answer 1' })
  await answer.getByLabel('Emoji').fill('💻')
  await answer.getByLabel('Answer', { exact: true }).fill('Computer')
  await answer.getByRole('checkbox', { name: 'PC', exact: true }).click()
  await answer.getByRole('checkbox', { name: '#general' }).click()
  await form.getByRole('button', { name: 'Add an answer' }).click()
  answer = form.getByRole('group', { name: 'Answer 2' })
  await answer.getByLabel('Answer', { exact: true }).fill('Console')
  await answer.getByRole('checkbox', { name: 'PlayStation', exact: true }).click()
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(section.locator('.onboarding-row', { hasText: 'Platform' })).toContainText('One answer · 💻 Computer, Console')
  await expect(section.locator('.onboarding-row', { hasText: 'Platform' })).toContainText('Required')

  await section.getByRole('button', { name: 'Add a question' }).click()
  form = section.getByRole('group', { name: 'Add a question' })
  await form.getByLabel('Title').fill('Pings')
  await form.getByRole('radio', { name: 'Several answers' }).click()
  await form.getByRole('group', { name: 'Answer 1' }).getByRole('checkbox', { name: 'Event pings', exact: true }).click() // no label: named after the role
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(section.locator('.onboarding-row', { hasText: 'Pings' })).toContainText('Several answers · Event pings')

  // ── Roles on join.
  const auto = host.getByTestId('auto-roles')
  await auto.getByRole('checkbox', { name: 'Newcomer', exact: true }).click()
  await auto.getByRole('button', { name: 'Save roles on join' }).click()
  await expect(auto.getByRole('status')).toHaveText('Saved.')
  // Not retroactive, unless asked: "Give to everyone now" (only the host is here so far).
  host.once('dialog', (d) => void d.accept())
  await auto.getByRole('button', { name: 'Give to everyone now' }).click()
  await expect(auto.getByRole('status')).toHaveText('1 member got them.')
  await host.screenshot({ path: join(SHOTS, 'join-questions-settings.png'), fullPage: true })
  await host.keyboard.press('Escape')

  // ── A friend joins on a phone: the questions open by themselves, one at a time.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, invite, 'Sam')
  const flow = phone.getByRole('dialog', { name: 'Welcome to Join Test' })
  await expect(flow).toBeVisible()
  await expect(flow.getByText('Question 1 of 2')).toBeVisible()
  await expect(flow.getByRole('heading', { name: 'What do you play on?' })).toBeVisible()
  await expect(phone.getByTestId('join-questions-next')).toBeDisabled() // required
  await expect(flow.getByRole('button', { name: 'Skip for now' })).toHaveCount(0)
  await flow.getByRole('radio', { name: 'Computer' }).click()
  await expect(flow.getByRole('radio', { name: 'Computer' })).toHaveAttribute('aria-checked', 'true')
  await expect(flow.getByText('Gives PC')).toBeVisible()
  await phone.screenshot({ path: join(SHOTS, 'join-questions-phone.png') })
  await phone.getByTestId('join-questions-next').click()
  await expect(flow.getByText('Question 2 of 2')).toBeVisible()
  await expect(phone.getByTestId('join-questions-next')).toHaveText('Finish')
  await flow.getByRole('checkbox', { name: 'Event pings' }).click()
  await phone.getByTestId('join-questions-next').click()
  await expect(flow.getByTestId('join-questions-finished')).toBeVisible()
  await expect(flow.getByRole('button', { name: 'Open #general' })).toBeVisible()
  await phone.screenshot({ path: join(SHOTS, 'join-questions-done-phone.png') })
  await flow.getByRole('button', { name: 'Open #general' }).click()
  await expect(flow).toHaveCount(0)
  await expect(phone.getByPlaceholder('Message #general')).toBeVisible()

  // The host sees what the answers and the join gave.
  let chips = await rolesOf(host, 'Sam')
  for (const role of ['PC', 'Event pings', 'Newcomer']) await expect(chips).toContainText(role)
  await expect(chips).not.toContainText('PlayStation')
  await host.keyboard.press('Escape')

  // ── Later, from the server menu: change an answer. The role the old answer gave goes; Newcomer stays.
  await phone.getByRole('button', { name: 'Open channels' }).click()
  await phone.locator('.server-header-button').click()
  await phone.getByRole('menuitem', { name: 'Change my answers' }).click()
  const change = phone.getByRole('dialog', { name: 'Your answers on Join Test' })
  await expect(change).toBeVisible()
  await expect(change.getByRole('radio', { name: 'Computer' })).toHaveAttribute('aria-checked', 'true')
  await change.getByRole('radio', { name: 'Console' }).click()
  await phone.getByTestId('join-questions-next').click()
  await expect(change.getByText('Question 2 of 2')).toBeVisible()
  await phone.getByTestId('join-questions-next').click()
  await phone.getByTestId('join-questions-done').click()
  chips = await rolesOf(host, 'Sam')
  await expect(chips).toContainText('PlayStation')
  await expect(chips).toContainText('Newcomer')
  await expect(chips).not.toContainText('PC')
  // Answering never lifts anyone: Sam is still a plain member to the host's moderation tools.
  await host.getByRole('dialog', { name: 'Profile of Sam' }).getByRole('button', { name: 'More' }).click()
  await expect(host.getByRole('dialog', { name: 'Sam' }).getByRole('button', { name: 'Kick' })).toBeVisible()
  await host.keyboard.press('Escape')

  // ── With rules to agree to, the rules come first, then the questions.
  await openServerSettings(host, 'Server rules')
  const rules = host.getByTestId('rules-section')
  await rules.getByLabel('Rules').fill('1. Be kind.')
  await rules.getByRole('checkbox', { name: /Members must agree/ }).check()
  await rules.getByRole('button', { name: 'Save' }).click()
  await expect(rules.getByRole('status')).toHaveText('Saved.')
  await host.keyboard.press('Escape')

  const kim = await (await browser.newContext()).newPage()
  await joinVia(kim, invite, 'Kim')
  await expect(kim.getByTestId('rules-agree')).toBeVisible()
  await kim.getByTestId('rules-agree').click()
  const kimFlow = kim.getByRole('dialog', { name: 'Welcome to Join Test' })
  await expect(kimFlow.getByText('Question 1 of 2')).toBeVisible()
  await kimFlow.getByRole('radio', { name: 'Console' }).click()
  await kim.getByTestId('join-questions-next').click()
  await expect(kim.getByTestId('join-questions-next')).toHaveText('Finish')
  await kim.getByTestId('join-questions-next').click() // nothing picked on an optional question
  await kim.getByTestId('join-questions-done').click()
  chips = await rolesOf(host, 'Kim')
  await expect(chips).toContainText('PlayStation')
  await expect(chips).toContainText('Newcomer')
})
