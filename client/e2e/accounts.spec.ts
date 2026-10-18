// Several accounts in one app: add a second account, both on their own servers, switch, unread on the account in the
// background, links ask which account, one account in voice at a time, nothing shared between them, and signing one out.
import { join } from 'node:path'
import { expect, test, type Frame, type FrameLocator, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let one: TestServer
let two: TestServer
test.beforeAll(async () => {
  ;[one, two] = await Promise.all([startServer('Accounts One', hasLiveKit()), startServer('Accounts Two', hasLiveKit())])
})
test.afterAll(async () => Promise.all([one?.stop(), two?.stop()]))

const account = (page: Page, slot: number): FrameLocator => page.frameLocator(`iframe[data-account="${slot}"]`)
const frameOf = (page: Page, slot: number): Frame => page.frames().find((f) => new URL(f.url()).searchParams.get('account') === String(slot))!

async function openSwitcher(app: FrameLocator) {
  await app.getByTestId('account-switcher').click()
  await expect(app.getByRole('dialog', { name: 'Accounts' })).toBeVisible()
}

async function switchTo(page: Page, from: number, name: string) {
  const app = account(page, from)
  await openSwitcher(app)
  await app.getByRole('menuitemradio', { name: `Switch to ${name}` }).click()
}

async function voiceChannel(app: Page | FrameLocator, name: string) {
  await app.getByRole('button', { name: 'Create voice channel' }).click()
  await app.getByRole('radio', { name: 'Voice' }).click()
  await app.getByLabel('Name').fill(name)
  await app.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(app.locator('.voice-channel', { hasText: name })).toBeVisible()
}

test('two accounts in one app, each with its own servers, unread, links and voice', async ({ browser }) => {
  test.setTimeout(180_000)
  // Cy owns the second server; Ada is the person with two accounts on one device.
  const cy = await (await browser.newContext()).newPage()
  await joinVia(cy, two.ownerLink(), 'Cy')
  if (hasLiveKit()) await voiceChannel(cy, 'lounge')
  const page = await (await browser.newContext()).newPage()
  await joinVia(page, one.ownerLink(), 'Ada')

  // One account: the switcher shows it, and offers to add one.
  await page.getByTestId('account-switcher').click()
  const menu = page.getByRole('dialog', { name: 'Accounts' })
  await expect(menu.getByRole('menuitemradio', { name: 'Ada' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Add account' }).click()
  await expect(menu.getByText('Iskra restarts once to add the account.')).toBeVisible()
  await menu.getByRole('menuitem', { name: /Create a new account/ }).click()

  // The page comes back holding both accounts; the new one starts on "pick a name".
  const ada = account(page, 1)
  const bea = account(page, 2)
  await expect(bea.getByLabel('Your name')).toBeVisible({ timeout: 20_000 })
  await expect(bea.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await bea.getByLabel('Your name').fill('Bea')
  await bea.getByRole('button', { name: 'Continue' }).click()
  await expect(bea.getByTestId('account-switcher')).toBeVisible()

  // An invite opened in the browser: which account should join?
  const invite = await createInviteLink(cy)
  await page.goto(invite)
  const chooser = page.getByRole('dialog', { name: 'Which account?' })
  await expect(chooser).toBeVisible({ timeout: 20_000 })
  await expect(chooser.getByText('You opened an invite. Which account should join?')).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'accounts-chooser.png') })
  await chooser.getByRole('button', { name: 'Bea' }).click()
  await bea.getByRole('button', { name: 'Join server' }).click()
  await expect(bea.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(cy.locator('.member-list')).toContainText('Bea')
  // Ada is still on her own server, and isn't on Bea's.
  await expect(account(page, 1).locator('.server-rail')).not.toContainText('Accounts Two')

  // Each account's storage is its own: a draft typed as Bea isn't Ada's, and the databases are apart.
  await bea.getByPlaceholder('Message #general').fill('draft only bea has 5150')
  await expect.poll(() => frameOf(page, 2).evaluate(() => localStorage.getItem('iskra.drafts') ?? '')).toContain('5150')
  expect(await frameOf(page, 1).evaluate(() => localStorage.getItem('iskra.drafts') ?? '')).not.toContain('5150')
  expect(await frameOf(page, 1).evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('iskra@')))).toEqual([])
  expect(await frameOf(page, 2).evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('iskra@')))).toEqual([])
  const stored = await page.evaluate(async () => ({
    keys: Object.keys(localStorage),
    dbs: ((await indexedDB.databases?.()) ?? []).map((d) => d.name),
  }))
  expect(stored.keys).toContain('iskra@2:iskra.drafts')
  expect(stored.dbs).toEqual(expect.arrayContaining(['iskra', 'iskra@2']))
  await bea.getByPlaceholder('Message #general').fill('')

  // Back to Ada: Bea keeps running in the background and counts a DM from Cy.
  await switchTo(page, 2, 'Ada')
  await expect(page.locator('iframe[data-account="1"]')).toBeVisible()
  await cy.locator('.member-list').getByRole('button', { name: 'Bea' }).click()
  await cy.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await cy.getByPlaceholder('Message Bea').fill('psst bea 77')
  await cy.getByPlaceholder('Message Bea').press('Enter')
  await expect(ada.getByTestId('account-switcher').locator('.badge')).toHaveText('1', { timeout: 20_000 })
  await expect(page).toHaveTitle(/^\(1\) Iskra/)
  await openSwitcher(ada)
  await expect(ada.getByRole('menuitemradio', { name: 'Switch to Bea' })).toContainText('1 unread')
  await page.screenshot({ path: join(SHOTS, 'accounts-switcher.png') })
  await ada.getByRole('menuitemradio', { name: 'Switch to Bea' }).click()
  await expect(bea.getByRole('button', { name: 'Direct messages' })).toBeVisible()

  // A reload keeps both accounts signed in, each with its own servers.
  await page.reload()
  await expect(account(page, 1).getByRole('heading', { name: 'general', exact: true })).toBeAttached({ timeout: 20_000 })
  await expect(account(page, 2).locator('.server-rail')).toContainText('', { timeout: 20_000 })
  await expect(account(page, 2).getByTestId('account-switcher')).toBeVisible()

  if (hasLiveKit()) {
    // One device, one microphone: Bea joining voice takes Ada out of it, calmly, with a way back.
    await switchTo(page, 2, 'Ada')
    await voiceChannel(ada, 'lounge')
    await ada.locator('.voice-channel', { hasText: 'lounge' }).getByRole('button').first().click()
    await expect(ada.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    await switchTo(page, 1, 'Bea')
    await account(page, 2).locator('.voice-channel', { hasText: 'lounge' }).getByRole('button').first().click()
    await expect(account(page, 2).locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    await expect(account(page, 2).getByTestId('account-toast')).toContainText('Left voice as Ada')
    await switchTo(page, 2, 'Ada')
    const note = ada.getByTestId('voice-other-account')
    await expect(note).toContainText('You left voice because you joined as Bea.')
    await page.screenshot({ path: join(SHOTS, 'accounts-voice-moved.png') })
    // "Join here" takes voice back: now Bea is the one out.
    await note.getByRole('button', { name: 'Join here' }).click()
    await expect(ada.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    await expect(account(page, 2).getByTestId('voice-other-account')).toContainText('You left voice because you joined as Ada.')
    await ada.getByRole('button', { name: 'Leave voice' }).click()
  }

  // Signing Bea out takes only Bea away: Ada stays, and nothing of Bea's is left on the device.
  await switchTo(page, 1, 'Bea')
  const beaNow = account(page, 2)
  await openSwitcher(beaNow)
  await beaNow.getByRole('menuitem', { name: 'Sign out of Bea…' }).click()
  const dialog = beaNow.getByRole('dialog', { name: 'Sign out of this device' })
  await dialog.getByLabel('I understand this account will be gone for good').check()
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.locator('iframe[data-account="2"]')).toHaveCount(0, { timeout: 20_000 })
  await expect(account(page, 1).getByRole('heading', { name: 'general', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(async () => ({
    keys: Object.keys(localStorage).filter((k) => k.startsWith('iskra@2:')),
    dbs: ((await indexedDB.databases?.()) ?? []).map((d) => d.name).filter((n) => n?.endsWith('@2')),
    list: JSON.parse(localStorage.getItem('iskra-accounts') ?? '{}').order,
  })), { timeout: 15_000 }).toEqual({ keys: [], dbs: [], list: [1] })
  await cy.locator('.server-rail').getByRole('button', { name: /^Accounts Two/ }).click()
  await expect(cy.locator('.member-list')).not.toContainText('Bea')
})

test('an existing install becomes account 1 as it is, and adding an account can be cancelled', async ({ browser }) => {
  const solo = await startServer('Accounts Solo')
  const page = await (await browser.newContext()).newPage()
  await joinVia(page, solo.ownerLink(), 'Solo')
  // Nothing about accounts was stored for a single account.
  expect(await page.evaluate(() => localStorage.getItem('iskra-accounts'))).toBeNull()
  await page.getByTestId('account-switcher').click()
  await page.getByRole('menuitem', { name: 'Add account' }).click()
  await page.getByRole('menuitem', { name: /Use an account I already have/ }).click()
  const added = account(page, 2)
  await expect(added.getByRole('button', { name: /Link with my other device/ })).toBeVisible({ timeout: 20_000 })
  await expect(added.getByRole('button', { name: /Use my recovery key/ })).toBeVisible()
  // Changed my mind: back to Solo, and the half-made account leaves nothing behind.
  await added.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('iframe[data-account="2"]')).toHaveCount(0)
  await expect(account(page, 1).getByRole('heading', { name: 'general', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('iskra@2:')))).toEqual([])
  await solo.stop()
})

test('the same account twice: voice moves calmly between its devices, and adding it again here goes to the first copy', async ({ browser }) => {
  test.setTimeout(120_000)
  const same = await startServer('Accounts Same', hasLiveKit())
  const first = await (await browser.newContext()).newPage()
  await joinVia(first, same.ownerLink(), 'Ada')
  await first.getByRole('button', { name: 'My settings', exact: true }).click()
  await first.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Recovery key', exact: true }).click()
  await first.getByRole('button', { name: 'Show recovery key' }).click()
  const recoveryKey = (await first.locator('.recovery-key').innerText()).trim()
  await first.keyboard.press('Escape')

  if (hasLiveKit()) {
    // Ada's laptop and phone: joining voice on the second moves it there, said plainly, with a way back.
    const second = await (await browser.newContext()).newPage()
    await second.goto(await createInviteLink(first))
    await agreeToTerms(second)
    await second.getByRole('button', { name: /I already use Iskra/ }).click()
    await second.getByRole('button', { name: /Use my recovery key/ }).click()
    await second.getByLabel('Recovery key').fill(recoveryKey)
    await second.getByRole('button', { name: 'Restore my account' }).click()
    await expect(second.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
    await voiceChannel(first, 'lounge')
    await first.locator('.voice-channel', { hasText: 'lounge' }).getByRole('button').first().click()
    await expect(first.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    await second.locator('.voice-channel', { hasText: 'lounge' }).getByRole('button').first().click()
    await expect(second.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    const moved = first.getByTestId('voice-other-device')
    await expect(moved).toHaveText(/Moved to your other device\./, { timeout: 20_000 })
    await expect(first.getByRole('alert')).toHaveCount(0)
    await first.screenshot({ path: join(SHOTS, 'voice-moved-other-device.png') })
    await moved.getByRole('button', { name: 'Join here' }).click()
    await expect(first.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    await expect(second.getByTestId('voice-other-device')).toBeVisible({ timeout: 20_000 })
    await first.getByRole('button', { name: 'Leave voice' }).click()
  }

  // Adding Ada again on her first device (with her recovery key): Iskra keeps one copy and goes to it.
  await first.getByTestId('account-switcher').click()
  await first.getByRole('menuitem', { name: 'Add account' }).click()
  await first.getByRole('menuitem', { name: /Use an account I already have/ }).click()
  const again = account(first, 2)
  await again.getByRole('button', { name: /Use my recovery key/ }).click({ timeout: 20_000 })
  await again.getByLabel('Recovery key').fill(recoveryKey)
  await again.getByRole('button', { name: 'Restore my account' }).click()
  const dup = again.getByRole('dialog', { name: 'Already signed in here' })
  await expect(dup).toBeVisible({ timeout: 15_000 })
  await dup.getByRole('button', { name: 'Go to it' }).click()
  await expect(first.locator('iframe[data-account="2"]')).toHaveCount(0, { timeout: 20_000 })
  await expect(account(first, 1).getByRole('heading', { name: 'general', exact: true })).toBeVisible()
  await same.stop()
})

test('phone: the switcher sits in the drawer, and back works for the account on screen', async ({ browser }) => {
  const pocket = await startServer('Accounts Pocket')
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await joinVia(page, pocket.ownerLink(), 'Ada')
  await page.getByRole('button', { name: 'Open channels' }).first().click()
  await page.getByTestId('account-switcher').click()
  await page.getByRole('menuitem', { name: 'Add account' }).click()
  await page.getByRole('menuitem', { name: /Create a new account/ }).click()
  const gus = account(page, 2)
  await gus.getByLabel('Your name').fill('Gus')
  await gus.getByRole('button', { name: 'Continue' }).click()
  await expect(gus.getByRole('heading', { name: /No servers yet/ })).toBeVisible()

  // The browser's back goes to the account on screen (it opens Gus's drawer, as it would with one account).
  await expect.poll(() => page.evaluate(() => (history.state as Record<string, unknown> | null)?.iskraHost === true)).toBe(true)
  await page.goBack()
  await expect(gus.locator('.shell')).toHaveClass(/panel-nav/)
  await gus.getByTestId('account-switcher').click()
  await expect(gus.getByRole('dialog', { name: 'Accounts' })).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, 'accounts-phone.png') })
  await gus.getByRole('menuitemradio', { name: 'Switch to Ada' }).click()
  await expect(page.locator('iframe[data-account="1"]')).toBeVisible()
  await pocket.stop()
})
