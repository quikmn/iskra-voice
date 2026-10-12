// Regression checks for the UX audit's P1 fixes: sends wait for uploads, and an invite to a server that can't be
// reached says so instead of leaving a tile stuck on "Reconnecting".
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('UX Fixes')
})
test.afterAll(async () => server?.stop())

/** Holds every file upload (PUT) to the server until the returned function is called. */
async function holdUploads(page: Page): Promise<() => void> {
  let release!: () => void
  const released = new Promise<void>((done) => (release = done))
  await page.route(`${server.url}/**`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await released
    await route.continue()
  })
  return release
}

test('Enter while a file uploads: the message waits, says so, and goes out once the upload is done (channels and DMs)', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // A channel.
  let release = await holdUploads(host)
  await host.locator('.composer input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  const box = host.getByPlaceholder('Message #general')
  await box.fill('here are my notes')
  await box.press('Enter')
  const queued = host.getByRole('status').filter({ hasText: 'Sends when the upload finishes' })
  await expect(queued).toBeVisible()
  await expect(queued.getByRole('button', { name: 'Don’t send when the upload finishes' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'ux-queued-send.png') })
  release()
  await expect(host.locator('.message', { hasText: 'here are my notes' })).toContainText('notes.txt')
  await expect(queued).toHaveCount(0)
  await expect(box).toHaveValue('')
  await expect(friend.locator('.message', { hasText: 'here are my notes' })).toBeVisible()

  // Cancel keeps the draft and the file; nothing goes out.
  await host.unrouteAll()
  release = await holdUploads(host)
  await host.locator('.composer input[type=file]').setInputFiles({ name: 'later.txt', mimeType: 'text/plain', buffer: Buffer.from('later') })
  await box.fill('not yet')
  await box.press('Enter')
  await queued.getByRole('button', { name: 'Don’t send when the upload finishes' }).click()
  await expect(queued).toHaveCount(0)
  release()
  await expect(host.locator('.pending-upload', { hasText: 'later.txt' })).toContainText(/B$/)
  await expect(box).toHaveValue('not yet')
  await expect(host.locator('.message', { hasText: 'not yet' })).toHaveCount(0)

  // A DM.
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  const dmRelease = await holdUploads(friend)
  await friend.locator('.composer-wrap input[type=file]').setInputFiles({ name: 'secret.txt', mimeType: 'text/plain', buffer: Buffer.from('psst') })
  const dmBox = friend.getByPlaceholder('Message Host')
  await dmBox.fill('a file for you')
  await dmBox.press('Enter')
  const dmQueued = friend.getByRole('status').filter({ hasText: 'Sends when the upload finishes' })
  await expect(dmQueued).toBeVisible()
  dmRelease()
  await expect(friend.locator('.message', { hasText: 'a file for you' })).toContainText('secret.txt')
  await expect(dmQueued).toHaveCount(0)
})

test('an invite to a server that is not running: a clear error, Try again and Remove, and no tile left behind', async ({ browser }) => {
  const dead = await startServer('Gone')
  const link = dead.ownerLink()
  const host = new URL(dead.url).host
  await dead.stop()

  const page = await (await browser.newContext()).newPage()
  await page.goto(link)
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill('Wanderer')
  await page.getByRole('button', { name: 'Join' }).click()

  const failed = page.getByRole('alert').filter({ hasText: `Couldn't reach ${host}. Is the server running and open to the internet?` })
  await expect(failed).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Reconnecting in/)).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS, 'ux-join-unreachable.png') })
  await failed.getByRole('button', { name: 'Try again' }).click()
  await expect(failed).toBeVisible()
  await expect(page.locator('.server-rail').getByRole('button', { name: host })).toBeVisible()

  // Remove: gone from the rail, and not back after a reload.
  await failed.getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('.server-rail').getByRole('button', { name: host })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.server-rail')).toBeVisible()
  await expect(page.locator('.server-rail').getByRole('button', { name: host })).toHaveCount(0)

  // Going elsewhere instead of choosing also drops it.
  await page.goto(link)
  await page.getByRole('button', { name: 'Join server' }).click()
  await expect(failed).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Direct messages' }).click()
  await expect(page.locator('.server-rail').getByRole('button', { name: host })).toHaveCount(0)
})

test('restoring with the recovery key on a server the account is new to: it asks for the name only then, and says why', async ({ browser }) => {
  const home = await startServer('Home')
  const first = await (await browser.newContext()).newPage()
  await joinVia(first, home.ownerLink(), 'Rhea')
  await openSettings(first, 'Recovery key')
  await first.getByRole('button', { name: 'Show recovery key' }).click()
  const recoveryKey = (await first.locator('.recovery-key').innerText()).trim()
  await first.keyboard.press('Escape')

  const elsewhere = await startServer('Elsewhere')
  try {
    const restored = await (await browser.newContext()).newPage()
    await restored.goto(elsewhere.ownerLink())
    await agreeToTerms(restored)
    await restored.getByRole('button', { name: /I already use Iskra/ }).click()
    await restored.getByRole('button', { name: /Use my recovery key/ }).click()
    await restored.getByLabel('Recovery key').fill(recoveryKey)
    await expect(restored.getByLabel('Your name')).toHaveCount(0)
    await restored.getByRole('button', { name: 'Restore my account' }).click()

    // Nobody on this server knows the account yet: pick the name it shows.
    await expect(restored.getByRole('heading', { name: 'Pick your name' })).toBeVisible({ timeout: 15_000 })
    await expect(restored.getByText('This is your existing account; pick the name it shows.')).toBeVisible()
    await restored.screenshot({ path: join(SHOTS, 'ux-restore-pick-name.png') })
    await restored.getByLabel('Your name').fill('Rhea')
    await restored.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(restored.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
    await expect(restored.locator('.me-bar')).toContainText('Rhea')
  } finally {
    await elsewhere.stop()
    await home.stop()
  }
})

