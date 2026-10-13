import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

// One server per test: the owner invite works once.
let server: TestServer
test.beforeEach(async () => {
  server = await startServer('Group Test', hasLiveKit())
})
test.afterEach(async () => server?.stop())

async function people(browser: Browser, names: string[]): Promise<Page[]> {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), names[0])
  const link = await createInviteLink(host)
  const pages = [host]
  for (const name of names.slice(1)) {
    const page = await (await browser.newContext()).newPage()
    await joinVia(page, link, name)
    pages.push(page)
  }
  return pages
}

const home = (page: Page) => page.getByRole('button', { name: 'Direct messages' }).click()
const groupRow = (page: Page, name: string) => page.locator('.group-row', { hasText: name })

async function newGroup(page: Page, name: string, members: string[]) {
  await home(page)
  await page.getByRole('button', { name: 'New group' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New group' })
  await dialog.getByLabel('Group name (optional)').fill(name)
  for (const member of members) await dialog.locator('.person-pick', { hasText: member }).click()
  await dialog.getByRole('button', { name: 'Create group' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.group-title')).toHaveText(name)
}

async function say(page: Page, group: string, text: string) {
  const box = page.getByPlaceholder(`Message ${group}`)
  await box.fill(text)
  await box.press('Enter')
}

test('group DMs: end-to-end encrypted, with signed membership changes', async ({ browser }) => {
  test.setTimeout(120_000)
  const [host, bob, carol, dave] = await people(browser, ['Host', 'Bob', 'Carol', 'Dave'])

  await newGroup(host, 'Weekend crew', ['Bob', 'Carol'])
  await expect(host.locator('.system-line', { hasText: 'You created the group with Bob and Carol' })).toBeVisible()
  const secret = 'pizza at mine, door code 4471 🍕'
  await say(host, 'Weekend crew', secret)

  // Bob and Carol get it, with an unread badge, and read it decrypted.
  for (const page of [bob, carol]) {
    await expect(page.locator('.server-icon.home .badge')).toBeVisible()
    await home(page)
    await groupRow(page, 'Weekend crew').click()
    await expect(page.locator('.message-text', { hasText: secret })).toBeVisible()
    await expect(page.locator('.system-line', { hasText: 'Host named the group Weekend crew' })).toBeVisible()
  }
  await say(bob, 'Weekend crew', 'count me in')
  await expect(host.locator('.message-text', { hasText: 'count me in' })).toBeVisible()
  await expect(carol.locator('.message-text', { hasText: 'count me in' })).toBeVisible()

  // Bob (not the owner) adds Dave. Dave sees messages from then on, not before.
  await bob.getByRole('button', { name: 'Group members' }).click()
  await bob.getByRole('dialog').getByRole('button', { name: 'Add people' }).click()
  const add = bob.getByRole('dialog', { name: 'Add people' })
  await add.locator('.person-pick', { hasText: 'Dave' }).click()
  await add.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(add).toHaveCount(0)
  await expect(host.locator('.system-line', { hasText: 'Bob added Dave' })).toBeVisible()
  await home(dave)
  await groupRow(dave, 'Weekend crew').click()
  await expect(dave.locator('.system-line', { hasText: 'Bob added you' })).toBeVisible()
  await expect(dave.locator('.message-text', { hasText: secret })).toHaveCount(0)
  await say(dave, 'Weekend crew', 'hi all, thanks Bob')
  await expect(host.locator('.message-text', { hasText: 'hi all, thanks Bob' })).toBeVisible()

  // Only the owner sees Remove buttons. Host removes Carol, who can't write any more.
  await bob.getByRole('button', { name: 'Group members' }).click()
  await expect(bob.getByRole('dialog').locator('.friend-row')).toHaveCount(4)
  await expect(bob.getByRole('dialog').getByRole('button', { name: /^Remove/ })).toHaveCount(0)
  await bob.keyboard.press('Escape')
  await host.getByRole('button', { name: 'Group members' }).click()
  const members = host.getByRole('dialog')
  await expect(members.locator('.friend-row')).toHaveCount(4)
  await host.screenshot({ path: join(SHOTS, 'group-members.png') })
  await members.getByRole('button', { name: 'Remove Carol from the group' }).click()
  await members.getByRole('button', { name: 'Remove Carol', exact: true }).click()
  await expect(members.locator('.friend-row')).toHaveCount(3)
  await host.keyboard.press('Escape')
  await expect(carol.locator('.system-line', { hasText: 'Host removed you' })).toBeVisible()
  await expect(carol.locator('.composer.read-only')).toContainText("You're not in this group any more.")
  await say(host, 'Weekend crew', 'carol-free zone now')
  await expect(bob.locator('.message-text', { hasText: 'carol-free zone now' })).toBeVisible()
  await expect(carol.locator('.message-text', { hasText: 'carol-free zone now' })).toHaveCount(0)

  // Rename, on a phone.
  await bob.setViewportSize({ width: 390, height: 844 })
  await bob.getByRole('button', { name: 'Group members' }).click()
  await bob.getByRole('dialog').getByRole('button', { name: 'Rename' }).click()
  const rename = bob.getByRole('dialog', { name: 'Rename group' })
  await rename.getByLabel('Group name').fill('Pizza club')
  await rename.getByRole('button', { name: 'Save' }).click()
  await expect(host.locator('.group-title')).toHaveText('Pizza club')
  await expect(dave.locator('.system-line', { hasText: 'Bob named the group Pizza club' })).toBeVisible()
  await bob.screenshot({ path: join(SHOTS, 'group-phone.png') })
  await host.screenshot({ path: join(SHOTS, 'group.png') })

  // The server stores only ciphertext: no message text, no group name.
  for (const file of readdirSync(server.world).filter((f) => f.startsWith('iskra.db'))) {
    const bytes = readFileSync(join(server.world, file))
    for (const text of ['door code 4471', 'count me in', 'Weekend crew', 'Pizza club']) expect(bytes.includes(Buffer.from(text))).toBe(false)
  }
})

test('group calls: ring everyone, join, and rekey when someone leaves the group', async ({ browser }) => {
  test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')
  test.setTimeout(180_000)
  const [host, bob, carol] = await people(browser, ['Hana', 'Ben', 'Cleo'])
  await newGroup(host, 'Call crew', ['Ben', 'Cleo'])
  await bob.setViewportSize({ width: 390, height: 844 })
  const panel = (page: Page) => page.locator('.call-panel.group-call')

  // Hana starts a voice call; Ben and Cleo are rung and join.
  await host.getByRole('button', { name: 'Start voice call' }).click()
  await expect(panel(host)).toBeVisible()
  for (const page of [bob, carol]) {
    const ring = page.getByRole('alertdialog')
    await expect(ring).toContainText('Hana started a voice call')
    if (page === bob) await bob.screenshot({ path: join(SHOTS, 'group-call-incoming-phone.png') })
    await ring.getByRole('button', { name: 'Join' }).click()
    await expect(ring).toHaveCount(0)
  }
  for (const page of [host, bob, carol]) {
    await expect(panel(page).locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 25_000 })
    await expect(panel(page).locator('.e2e-badge')).toHaveText('End-to-end encrypted')
    await expect(panel(page).locator('.e2e-badge')).not.toHaveClass(/pending/, { timeout: 15_000 }) // keys in, not just the label
    await expect(panel(page).locator('.person-tile, .video-tile')).toHaveCount(3, { timeout: 15_000 })
  }
  // Audio arrives and plays (it would be silence if it couldn't be decrypted).
  await expect
    .poll(() => bob.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)), { timeout: 15_000 })
    .toBe(true)

  // Cleo turns her camera on; Hana sees it, decoded from encrypted frames.
  await panel(carol).getByRole('button', { name: 'Turn camera on' }).click()
  const video = panel(host).locator('.video-tile video')
  await expect(video).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)
  await host.screenshot({ path: join(SHOTS, 'group-call.png') })
  await bob.screenshot({ path: join(SHOTS, 'group-call-phone.png') })

  // Hana removes Cleo from the group: Cleo is dropped from the call, and Hana (in it longest) sends a new key.
  await host.getByRole('button', { name: 'Group members' }).click()
  await host.getByRole('dialog').getByRole('button', { name: 'Remove Cleo from the group' }).click()
  await host.getByRole('dialog').getByRole('button', { name: 'Remove Cleo', exact: true }).click()
  await host.keyboard.press('Escape')
  await expect(panel(carol)).toHaveCount(0, { timeout: 15_000 })
  await expect(panel(host)).toHaveAttribute('data-key-version', '2', { timeout: 15_000 })
  for (const page of [host, bob]) await expect(panel(page).locator('.person-tile, .video-tile')).toHaveCount(2, { timeout: 15_000 })
  // Ben still hears Hana under the new key.
  const playing = () => bob.evaluate(() => Math.max(0, ...[...document.querySelectorAll('audio')].map((a) => a.currentTime)))
  const before = await playing()
  await expect.poll(playing, { timeout: 10_000 }).toBeGreaterThan(before + 1)
  await expect(panel(bob).locator('.call-error')).toHaveCount(0)

  // Ben leaves; Hana hangs up: the call is over for the group.
  await panel(bob).getByRole('button', { name: 'Hang up' }).click()
  await expect(panel(bob)).toHaveCount(0)
  await expect(bob.locator('.ongoing-call')).toBeVisible()
  await panel(host).getByRole('button', { name: 'Hang up' }).click()
  await expect(bob.locator('.ongoing-call')).toHaveCount(0, { timeout: 10_000 })
  await expect(host.locator('.system-line', { hasText: 'You started a voice call' })).toBeVisible()
})
