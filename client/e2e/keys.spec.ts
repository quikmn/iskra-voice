import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Keys Test')
})
test.afterAll(async () => server?.stop())

async function recoveryKeyOf(page: Page): Promise<string> {
  await openSettings(page, 'Recovery key')
  await page.getByRole('button', { name: 'Show recovery key' }).click()
  const key = (await page.locator('.recovery-key').innerText()).trim()
  await page.keyboard.press('Escape')
  return key
}

async function restore(page: Page, link: string, recoveryKey: string, name: string) {
  await page.goto(link)
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I already use Iskra/ }).click()
  await page.getByRole('button', { name: /Use my recovery key/ }).click()
  await page.getByLabel('Recovery key').fill(recoveryKey)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Restore my account' }).click()
}

/** What IndexedDB holds for a slot, as stored (not decrypted). */
const rawSlot = (page: Page, slot: string) =>
  page.evaluate((key) => new Promise<unknown>((resolve, reject) => {
    const open = indexedDB.open('iskra', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('kv', 'readonly').objectStore('kv').get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }
  }), slot)

test('replacing the account key: your other device and your friends follow, the old recovery key stops working', async ({ browser }) => {
  const ownerLink = server.ownerLink() // any link to the server works for members later
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, ownerLink, 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // Keys are encrypted at rest from the start.
  expect(await rawSlot(host, 'identity')).toMatchObject({ $sealed: 1 })

  const oldRecoveryKey = await recoveryKeyOf(host)
  const oldId = await (async () => {
    await openSettings(host, 'Recovery key')
    const id = await host.getByTestId('account-id').innerText()
    await host.keyboard.press('Escape')
    return id
  })()

  // A second device of the same account.
  const phone = await (await browser.newContext()).newPage()
  await restore(phone, ownerLink, oldRecoveryKey, 'Host')
  await expect(phone.getByRole('heading', { name: 'general' })).toBeVisible()

  // A DM before the change.
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('button', { name: 'Add friend' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await friend.getByPlaceholder('Message Host').fill('written before the new key')
  await friend.getByPlaceholder('Message Host').press('Enter')
  await expect(friend.locator('.message-text', { hasText: 'written before the new key' })).toBeVisible()

  // Replace the key, keeping the phone.
  await openSettings(host, 'Recovery key')
  await host.getByRole('button', { name: 'Replace account key' }).click()
  const dialog = host.getByRole('dialog', { name: 'Replace account key' })
  await expect(dialog.locator('.key-devices .checkbox')).toHaveCount(1)
  await dialog.getByText(/I understand my old recovery key/).click()
  await host.screenshot({ path: join(SHOTS, 'keys-replace.png') })
  await dialog.getByRole('button', { name: 'Replace key' }).click()

  const newKeyDialog = host.getByRole('dialog', { name: 'Your account has a new key' })
  await expect(newKeyDialog).toBeVisible()
  const newRecoveryKey = (await newKeyDialog.getByTestId('new-recovery-key').innerText()).trim()
  expect(newRecoveryKey).toMatch(/^ISKRA-/)
  expect(newRecoveryKey).not.toBe(oldRecoveryKey)
  await host.screenshot({ path: join(SHOTS, 'keys-new-recovery-key.png') })
  await newKeyDialog.getByRole('button', { name: 'Done' }).click()
  await host.keyboard.press('Escape')
  await expect(host.locator('.me-text')).toContainText('owner')

  // The phone was handed the new key: same recovery key, still signed in.
  const phoneDialog = phone.getByRole('dialog', { name: 'Your account has a new key' })
  await expect(phoneDialog).toBeVisible()
  expect((await phoneDialog.getByTestId('new-recovery-key').innerText()).trim()).toBe(newRecoveryKey)
  await phoneDialog.getByRole('button', { name: 'Done' }).click()
  await expect(phone.locator('.me-text')).toContainText('owner')

  // The friend keeps the conversation and is told the safety number changed.
  await expect(friend.getByTestId('key-notice')).toContainText("Host's account key changed")
  await expect(friend.locator('.message-text', { hasText: 'written before the new key' })).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'keys-safety-number-changed.png') })
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await host.locator('.dm-row', { hasText: 'Friend' }).click()
  await expect(host.locator('.message-text', { hasText: 'written before the new key' })).toBeVisible()
  await host.getByPlaceholder('Message Friend').fill('hello from my new key')
  await host.getByPlaceholder('Message Friend').press('Enter')
  await expect(friend.locator('.message-text', { hasText: 'hello from my new key' })).toBeVisible()

  // The account ID changed.
  await openSettings(host, 'Recovery key')
  await expect(host.getByTestId('account-id')).not.toHaveText(oldId)
  await host.keyboard.press('Escape')

  // Someone with the old recovery key gets nowhere, and is told so.
  const thief = await (await browser.newContext()).newPage()
  await restore(thief, ownerLink, oldRecoveryKey, 'Host')
  await expect(thief.getByText('Your account key was replaced')).toBeVisible()
  await thief.screenshot({ path: join(SHOTS, 'keys-retired.png') })
})

test('app lock: a passphrase protects the keys and is asked for at startup', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/')
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill('Locked')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('No servers yet')).toBeVisible()

  await openSettings(page, 'App lock')
  await expect(page.getByTestId('key-protection')).toContainText('this browser keeps for Iskra')
  await page.getByRole('button', { name: 'Set a passphrase' }).click()
  await page.getByLabel('New passphrase').fill('purple otter lantern')
  await page.getByLabel('Repeat it').fill('purple otter lantern')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('App lock passphrase saved.')).toBeVisible()
  expect(await rawSlot(page, 'vault')).toHaveProperty('lock')

  // Next start (on a phone-sized window): locked until the passphrase is given.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByText('Iskra is locked')).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'keys-lock-phone.png') })
  await page.getByLabel('App lock passphrase').fill('wrong guess')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByText("That passphrase isn't right.")).toBeVisible()
  await page.getByLabel('App lock passphrase').fill('purple otter lantern')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByText('No servers yet')).toBeVisible()
  expect(await rawSlot(page, 'identity')).toMatchObject({ $sealed: 1 })
})
