// Profile sync: one account on two devices. A rename on one shows on the other by itself, and the other device
// coming back with its old profile doesn't put the old name back, for the server or anyone else.
import { join } from 'node:path'
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Sync Test')
})
test.afterAll(async () => server?.stop())

const exactly = (name: string) => new RegExp(`^${name}$`)
const listed = (page: Page, name: string) => page.locator('.member-list .member-name', { hasText: exactly(name) })

async function rename(page: Page, name: string) {
  await openSettings(page)
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByText('Saved. Your name is updated everywhere.')).toBeVisible()
  await page.keyboard.press('Escape')
}

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

test('a rename on one device reaches the other, and the other coming back with its old name changes nothing', async ({ browser }) => {
  test.setTimeout(120_000)
  const a = await (await browser.newContext()).newPage()
  await joinVia(a, server.ownerLink(), 'Ana')
  const c = await (await browser.newContext()).newPage()
  let watching = false
  const oldNameSent: string[] = []
  c.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (watching && typeof payload === 'string' && payload.includes('"member.updated"') && payload.includes('"Anya"')) oldNameSent.push(payload)
  }))
  await joinVia(c, await createInviteLink(a), 'Cleo')

  // B is Ana's second device. Its connection goes through a switch that can drop it.
  const b = await (await browser.newContext()).newPage()
  let down = false
  const open: WebSocketRoute[] = []
  await b.routeWebSocket(/\/ws$/, (ws) => {
    if (down) return void ws.close({ code: 1006, reason: 'network' }).catch(() => undefined)
    open.push(ws)
    ws.connectToServer()
  })
  await link(a, b)
  await expect(b.locator('.me-bar')).toContainText('Ana')

  // 1. Rename on A: B shows it without doing anything, and so does everyone else.
  await rename(a, 'Anya')
  await expect(b.locator('.me-bar')).toContainText('Anya')
  await expect(listed(c, 'Anya')).toHaveCount(1)
  await expect(listed(c, 'Ana')).toHaveCount(0)
  await openSettings(b)
  await expect(b.getByLabel('Name', { exact: true })).toHaveValue('Anya')
  await b.keyboard.press('Escape')

  // 2. B is offline while A renames again, so it still has the old profile when it comes back.
  down = true
  for (const ws of open.splice(0)) await ws.close({ code: 1006, reason: 'network' }).catch(() => undefined)
  await expect(b.locator('.pill.offline, .pill.connecting').first()).toBeVisible()
  await rename(a, 'Annika')
  await expect(listed(c, 'Annika')).toHaveCount(1)
  await expect(b.locator('.me-bar')).toContainText('Anya')
  // From here on, C notes it if the server ever sends the old name again, even for a moment.
  watching = true
  down = false

  // B reconnects with "Anya" (older stamp): the server keeps "Annika", nobody sees the old name come back, and B
  // takes the newer profile by itself.
  await expect(b.locator('.me-bar')).toContainText('Annika', { timeout: 60_000 })
  for (const page of [a, b, c]) {
    await expect(listed(page, 'Annika')).toHaveCount(1)
    await expect(listed(page, 'Anya')).toHaveCount(0)
  }
  await b.screenshot({ path: join(SHOTS, 'profile-sync-second-device.png') })

  // A full restart of B (profile from its storage, now the new one) changes nothing either.
  await b.reload()
  await expect(b.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
  await expect(b.locator('.me-bar')).toContainText('Annika')
  await c.waitForTimeout(500)
  await expect(listed(c, 'Annika')).toHaveCount(1)
  expect(oldNameSent).toEqual([])

  // 3. An edit on B after catching up wins everywhere, A included.
  await rename(b, 'Ann')
  await expect(a.locator('.me-bar')).toContainText('Ann')
  await expect(a.locator('.me-bar')).not.toContainText('Annika')
  for (const page of [a, c]) await expect(listed(page, 'Ann')).toHaveCount(1)
  await c.screenshot({ path: join(SHOTS, 'profile-sync-others.png') })
})

test('a device restored from the recovery key takes the current profile, not the name typed in', async ({ browser }) => {
  const other = await startServer('Restore Sync')
  try {
    const ownerLink = other.ownerLink()
    const first = await (await browser.newContext()).newPage()
    await joinVia(first, ownerLink, 'Bea')
    const friend = await (await browser.newContext()).newPage()
    await joinVia(friend, await createInviteLink(first), 'Finn')
    await rename(first, 'Beatrix')
    await expect(listed(friend, 'Beatrix')).toHaveCount(1)

    await openSettings(first, 'Recovery key')
    await first.getByRole('button', { name: 'Show recovery key' }).click()
    const recoveryKey = (await first.locator('.recovery-key').innerText()).trim()
    await first.keyboard.press('Escape')

    const restored = await (await browser.newContext()).newPage()
    await restored.goto(ownerLink)
    await agreeToTerms(restored)
    await restored.getByRole('button', { name: /I already use Iskra/ }).click()
    await restored.getByRole('button', { name: /Use my recovery key/ }).click()
    await restored.getByLabel('Recovery key').fill(recoveryKey)
    await restored.getByRole('button', { name: 'Restore my account' }).click()
    await expect(restored.getByRole('heading', { name: 'general' })).toBeVisible()

    await expect(restored.locator('.me-bar')).toContainText('Beatrix')
    for (const page of [first, friend, restored]) {
      await expect(listed(page, 'Beatrix')).toHaveCount(1)
      await expect(listed(page, 'Bea')).toHaveCount(0)
    }
  } finally {
    await other.stop()
  }
})
