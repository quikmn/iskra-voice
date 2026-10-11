// Passkeys for the app lock (WebAuthn PRF, with Chromium's virtual authenticator) and key transparency
// (a server that shows someone a key its own signed log doesn't have).
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Transparency Test')
})
test.afterAll(async () => server?.stop())

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

/** A platform authenticator with user verification and PRF (hmac-secret), like Windows Hello or Touch ID. */
async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true, hasPrf: true,
    },
  })
  return { cdp, authenticatorId }
}

test('app lock with a passkey: the passkey unlocks the keys, and can be renamed and removed', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await addAuthenticator(page)
  await page.goto('/')
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill('Passkey Person')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('No servers yet')).toBeVisible()

  await openSettings(page, 'App lock')
  const passkeys = page.getByTestId('passkeys')
  await passkeys.getByRole('button', { name: 'Add a passkey' }).click()
  await passkeys.getByLabel('Name').fill('Test laptop')
  await passkeys.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Passkey added. Iskra will ask for it when it starts.')).toBeVisible()
  await expect(passkeys.getByTestId('passkey-row')).toContainText('Test laptop')
  await page.screenshot({ path: join(SHOTS, 'passkeys-settings.png') })
  // Passkey only: the stored data key is gone from the plain wrap, only the passkey's slot holds it.
  const vault = await rawSlot(page, 'vault') as { data: string; passkeys: unknown[] }
  expect(vault.data).toBe('')
  expect(vault.passkeys).toHaveLength(1)

  // Next start, phone-sized: locked until the passkey answers.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByText('Iskra is locked')).toBeVisible()
  await expect(page.getByLabel('App lock passphrase')).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS, 'passkeys-lock-phone.png') })
  await page.getByTestId('unlock-passkey').click()
  await expect(page.getByText('No servers yet')).toBeVisible()
  expect(await rawSlot(page, 'identity')).toMatchObject({ $sealed: 1 })

  // Rename, then remove it (confirmed with the passkey): the app lock is off again.
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page, 'App lock')
  await passkeys.getByRole('button', { name: 'Rename' }).click()
  await passkeys.getByLabel('Name').fill('Work laptop')
  await passkeys.getByRole('button', { name: 'Save' }).click()
  await expect(passkeys.getByTestId('passkey-row')).toContainText('Work laptop')
  await passkeys.getByRole('button', { name: 'Remove' }).click()
  await expect(passkeys.getByText(/only way to unlock Iskra/)).toBeVisible()
  await passkeys.getByRole('button', { name: 'Remove passkey' }).click()
  await expect(page.getByText('Passkey removed.')).toBeVisible()
  await page.reload()
  await expect(page.getByText('No servers yet')).toBeVisible()
})

test('key transparency: the log checks out, and a key the server never logged is flagged', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)

  // Settings → App lock shows each server's log; the log itself is checked entry by entry.
  await openSettings(host, 'App lock')
  const section = host.getByTestId('kt-section')
  await expect(section.getByTestId('kt-status')).toContainText(/entr(y|ies) · checked/)
  await expect(section.getByText('Nothing suspicious found.')).toBeVisible()
  await section.getByRole('button', { name: 'View log' }).click()
  await expect(host.getByTestId('kt-verdict')).toContainText('Checked: 1 entry')
  await expect(host.getByTestId('kt-log')).toContainText('Host joined')
  await host.screenshot({ path: join(SHOTS, 'kt-log.png'), animations: 'disabled' })
  await host.keyboard.press('Escape')
  await host.keyboard.press('Escape')

  // A lying server: Friend's app is shown Host under a key the server's own signed log doesn't have.
  const forged = 'Zm9yZ2VkLWtleS1mb3JnZWQta2V5LWZvcmdlZC1rZXk'
  const friend = await (await browser.newContext()).newPage()
  await friend.routeWebSocket(/\/ws$/, (ws) => {
    const upstream = ws.connectToServer()
    upstream.onMessage((message) => {
      if (typeof message !== 'string' || !message.includes('"welcome"')) return ws.send(message)
      const frame = JSON.parse(message)
      if (frame.type !== 'welcome') return ws.send(message)
      for (const member of frame.body.members) if (member.name === 'Host') member.accountKey = forged
      ws.send(JSON.stringify(frame))
    })
    ws.onMessage((message) => upstream.send(message))
  })
  await joinVia(friend, invite, 'Friend')
  const banner = friend.getByTestId('kt-banner')
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(banner).toContainText("isn't in its own signed key log")
  await friend.screenshot({ path: join(SHOTS, 'kt-forged-key.png') })

  // The honest view has nothing to report.
  await expect(host.getByTestId('kt-banner')).toHaveCount(0)

  // Friends compare notes inside their DMs: a signed summary of the logs they see rides along, and matches.
  const pal = await (await browser.newContext()).newPage()
  await joinVia(pal, await createInviteLink(host), 'Pal')
  await pal.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await pal.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await pal.getByPlaceholder('Message Host').fill('hello from pal')
  await pal.getByPlaceholder('Message Host').press('Enter')
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await host.locator('.dm-row', { hasText: 'Pal' }).click()
  await expect(host.locator('.message-text', { hasText: 'hello from pal' })).toBeVisible()
  await expect.poll(async () => Object.keys(((await rawSlot(host, 'kt')) as { gossipSeen?: object })?.gossipSeen ?? {}).length).toBe(1)
  await expect(host.getByTestId('kt-dm-warning')).toHaveCount(0)
  await expect(host.getByTestId('kt-banner')).toHaveCount(0)
})
