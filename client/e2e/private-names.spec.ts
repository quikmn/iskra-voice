import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, longPress, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Names Test')
})
test.afterAll(async () => server?.stop())

/** Links a fresh browser to the account signed in on `existing`, through the usual code and number check. */
async function link(existing: Page, fresh: Page) {
  await openSettings(existing, 'Devices')
  await existing.getByRole('button', { name: 'Link a device' }).click()
  await existing.getByRole('button', { name: 'Show code' }).click()
  const code = (await existing.getByTestId('link-code').innerText()).trim()

  await fresh.goto('/')
  await agreeToTerms(fresh)
  await fresh.getByRole('button', { name: /I already use Iskra/ }).click()
  await fresh.getByRole('button', { name: /Link with my other device/ }).click()
  await fresh.getByLabel('Or type the code').fill(code)
  await fresh.getByRole('button', { name: 'Link this device' }).click()
  const confirm = fresh.getByTestId('link-confirm')
  await expect(confirm).toHaveText(/^\d{3} \d{3}$/)
  await existing.getByLabel('Number on the new device').fill(await confirm.innerText())
  await existing.getByRole('button', { name: 'Link it', exact: true }).click()
  await expect(existing.getByText('Done! Your account is on the new device.')).toBeVisible()
  await expect(fresh.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
  await existing.keyboard.press('Escape')
  await existing.keyboard.press('Escape')
}

const memberRow = (page: Page, name: string) => page.locator('.member-list .member', { hasText: name })

test('a private name is shown to you everywhere and to nobody else', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const bob = await (await browser.newContext()).newPage()
  await joinVia(bob, await createInviteLink(host), 'Robert')
  await send(bob, 'hello from me')
  await expect(host.locator('.message .author', { hasText: 'Robert' })).toBeVisible()

  // Host gives Robert a private name from the person menu.
  await memberRow(host, 'Robert').click({ button: 'right' })
  await host.getByRole('menuitem', { name: 'Private name…' }).click()
  const field = host.getByTestId('private-name-field')
  await expect(field).toContainText('Only you see this name, on all your devices. Robert is not told, and neither is anyone else.')
  await field.getByLabel('Private name', { exact: true }).fill('Bobby from work')
  await host.screenshot({ path: join(SHOTS, 'private-name-menu.png') })
  await field.getByRole('button', { name: 'Save', exact: true }).click()

  // The member list, the message author, a mention and the profile card show it.
  await expect(memberRow(host, 'Bobby from work')).toBeVisible()
  await expect(memberRow(host, 'Robert')).toHaveCount(0)
  await expect(host.locator('.message .author').first()).toHaveText('Bobby from work')
  await send(host, 'ping @Bobby from work and again @Robert please') // the name everyone sees still makes a mention
  await expect(host.locator('.message .mention')).toHaveText(['@Bobby from work', '@Bobby from work'])
  await memberRow(host, 'Bobby from work').click()
  const card = host.locator('.profile-card')
  await expect(card.locator('.profile-name')).toHaveText('Bobby from work')
  await expect(card.getByTestId('real-name')).toHaveText('Real name: Robert')
  await host.screenshot({ path: join(SHOTS, 'private-name-card.png') })
  await host.keyboard.press('Escape')

  // Robert sees his own name in the mention, and the private name nowhere.
  await expect(bob.locator('.message .mention')).toHaveText(['@Robert', '@Robert'])
  expect(await bob.locator('body').innerText()).not.toContain('Bobby')

  // DMs and the friends page use it too.
  await memberRow(host, 'Bobby from work').click({ button: 'right' })
  await host.getByRole('menuitem', { name: 'Message' }).click()
  await expect(host.getByRole('heading', { name: 'Bobby from work' }).first()).toBeVisible()
  await host.getByPlaceholder('Message Bobby from work').fill('a private hello')
  await host.getByPlaceholder('Message Bobby from work').press('Enter')
  await expect(host.locator('.dm-row', { hasText: 'Bobby from work' })).toBeVisible()
  await bob.getByRole('button', { name: 'Direct messages' }).click()
  await bob.locator('.dm-row').first().click()
  await expect(bob.getByText('a private hello')).toBeVisible()
  expect(await bob.locator('body').innerText()).not.toContain('Bobby')

  // The list in My settings → Privacy & data.
  await host.locator('.server-rail').getByTitle('Names Test').click()
  await openSettings(host, 'Privacy & data')
  const section = host.getByTestId('private-names-section')
  await expect(section.locator('li')).toHaveText(/Bobby from work.*Real name: Robert/)
  await section.scrollIntoViewIfNeeded()
  await host.screenshot({ path: join(SHOTS, 'private-names-settings.png') })
  await host.keyboard.press('Escape')

  // Another device of the same account gets the name (sealed, through the server).
  const second = await (await browser.newContext()).newPage()
  await link(host, second)
  await expect(memberRow(second, 'Bobby from work')).toBeVisible({ timeout: 15_000 })

  // Removing it on the second device brings the real name back on both.
  await openSettings(second, 'Privacy & data')
  await second.getByTestId('private-names-section').getByRole('button', { name: 'Remove the private name Bobby from work' }).click()
  await expect(second.getByTestId('private-names-section')).toContainText('You have not given anyone a private name.')
  await second.keyboard.press('Escape')
  await expect(memberRow(second, 'Robert')).toBeVisible()
  await expect(memberRow(host, 'Robert')).toBeVisible({ timeout: 15_000 })
  await expect(host.locator('.message .author').first()).toHaveText('Robert')
})

test('on a phone the private name field opens in the person sheet', async ({ browser }) => {
  const world = await startServer('Names Phone Test')
  try {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, world.ownerLink(), 'Host')
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
    await joinVia(phone, await createInviteLink(host), 'Mia')

    await phone.getByRole('button', { name: 'Members', exact: true }).click()
    await longPress(phone, memberRow(phone, 'Host'))
    await phone.getByRole('menuitem', { name: 'Private name…' }).click()
    const field = phone.getByTestId('private-name-field')
    await field.getByLabel('Private name', { exact: true }).fill('Boss')
    await phone.screenshot({ path: join(SHOTS, 'private-name-phone.png') })
    await field.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(memberRow(phone, 'Boss')).toBeVisible()
  } finally {
    await world.stop()
  }
})
