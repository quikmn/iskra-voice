// Names: a new name from My profile shows everywhere at once, for you and for everyone else, also on a server that
// was offline at the time; a server nickname wins on its own server and "Use my name" goes back.
import { join } from 'node:path'
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Hangout', true)
})
test.afterAll(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })

/** A name as an exact text (so "Nine" doesn't match "Nineleven"). */
const exactly = (name: string) => new RegExp(`^${name}$`)

/** Every place a name shows on a server page: member list, voice list under the channel, call tiles, messages, mentions. */
async function expectNameEverywhere(page: Page, name: string, old: string) {
  await expect(page.locator('.member-list .member-name', { hasText: exactly(name) })).toHaveCount(1)
  await expect(page.locator('.member-list .member-name', { hasText: exactly(old) })).toHaveCount(0)
  await expect(lounge(page).locator('.member-name', { hasText: exactly(name) })).toHaveCount(1)
  await expect(lounge(page).locator('.member-name', { hasText: exactly(old) })).toHaveCount(0)
  await expect(page.locator('.stage .person-tile .tile-label', { hasText: exactly(name) })).toHaveCount(1)
  await page.locator('.channel', { hasText: 'general' }).click()
  await expect(page.locator('.author', { hasText: exactly(name) }).first()).toBeVisible()
  await expect(page.locator('.author', { hasText: exactly(old) })).toHaveCount(0)
  await expect(page.locator('.mention', { hasText: exactly(`@${name}`) }).first()).toBeVisible()
  await lounge(page).getByRole('button').first().click() // back to the call
}

test('a new name shows everywhere at once, for you and everyone else', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage()
  await joinVia(a, server.ownerLink(), 'Ana')
  await a.getByRole('button', { name: 'Create voice channel' }).click()
  await a.getByRole('radio', { name: 'Voice' }).click()
  await a.getByRole('dialog').getByLabel('Name').fill('lounge')
  await a.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(lounge(a)).toBeVisible()
  const b = await (await browser.newContext()).newPage()
  await joinVia(b, await createInviteLink(a), 'Bo')

  await send(a, 'hello from ana')
  const box = b.getByPlaceholder('Message #general')
  await box.pressSequentially('@An')
  await box.press('Enter')
  await box.pressSequentially('hi')
  await box.press('Enter')
  await expect(a.getByText('hello from ana')).toBeVisible()
  await expect(b.getByText('hello from ana')).toBeVisible()
  for (const page of [a, b]) {
    await lounge(page).getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected')
  }
  for (const page of [a, b]) await expect(lounge(page).locator('.voice-participants li')).toHaveCount(2)
  await expectNameEverywhere(b, 'Ana', 'Nineleven')

  // A renames herself in My profile.
  await openSettings(a)
  await expect(a.getByText('Shown everywhere: on all your servers, in DMs and to friends, except where you set a server nickname.')).toBeVisible()
  await a.getByLabel('Name', { exact: true }).fill('Nineleven')
  await a.getByRole('button', { name: 'Save profile' }).click()
  await expect(a.getByText('Saved. Your name is updated everywhere.')).toBeVisible()
  await a.keyboard.press('Escape')

  // Both see it everywhere without reconnecting.
  for (const page of [a, b]) await expectNameEverywhere(page, 'Nineleven', 'Ana')
  await expect(a.locator('.me-bar')).toContainText('Nineleven')
  await b.locator('.member-list .member', { hasText: 'Nineleven' }).click()
  const card = b.locator('.profile-card')
  await expect(card.locator('.profile-name')).toHaveText('Nineleven')
  await expect(card.locator('.profile-realname')).toHaveCount(0)
  await b.keyboard.press('Escape')
  // DMs use it too.
  await b.locator('.member-list .member', { hasText: 'Nineleven' }).click({ button: 'right' })
  await b.getByRole('menuitem', { name: 'Message' }).click()
  await expect(b.getByRole('heading', { name: 'Nineleven' }).first()).toBeVisible()
  await b.screenshot({ path: join(SHOTS, 'names-renamed-dm.png') })
  await b.locator('.server-rail').getByTitle('Hangout').click()
  await expect(lounge(b)).toBeVisible()

  // A server nickname wins on this server; the card shows the name under it.
  await a.locator('.member-list .member', { hasText: 'Nineleven' }).click({ button: 'right' })
  await a.getByRole('menuitem', { name: 'Server nickname…' }).click()
  const editor = a.locator('.user-menu-nick')
  await expect(editor).toContainText('Server nickname on Hangout. Only on this server. Leave empty to use your name (Nineleven).')
  await expect(editor.getByRole('button', { name: 'Use my name' })).toHaveCount(0)
  await editor.getByLabel('Server nickname', { exact: true }).fill('Nine')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  for (const page of [a, b]) await expectNameEverywhere(page, 'Nine', 'Nineleven')
  await b.locator('.member-list .member', { hasText: 'Nine' }).click()
  await expect(card.locator('.profile-name')).toHaveText('Nine')
  await expect(card.locator('.profile-realname')).toHaveText('Name: Nineleven')
  await b.screenshot({ path: join(SHOTS, 'names-nickname-card.png') })
  await b.keyboard.press('Escape')

  // Only those allowed get the entry: B can't change A's, the owner can change B's.
  await b.locator('.member-list .member', { hasText: 'Nine' }).click({ button: 'right' })
  await expect(b.getByRole('menuitem', { name: 'Profile' })).toBeVisible()
  await expect(b.getByRole('menuitem', { name: /Server nickname/ })).toHaveCount(0)
  await b.keyboard.press('Escape')
  await a.locator('.member-list .member', { hasText: 'Bo' }).click({ button: 'right' })
  await expect(a.getByRole('menuitem', { name: 'Server nickname for Bo…' })).toBeVisible()
  await a.keyboard.press('Escape')

  // With a nickname set, My profile says where it shows instead of the name.
  await openSettings(a)
  await expect(a.getByText(/Your server nickname is shown instead on Hangout\./)).toBeVisible()
  await a.keyboard.press('Escape')

  // "Use my name" removes the nickname.
  await a.locator('.member-list .member', { hasText: 'Nine' }).click({ button: 'right' })
  await a.getByRole('menuitem', { name: 'Server nickname…' }).click()
  await a.screenshot({ path: join(SHOTS, 'names-nickname-editor.png') })
  await editor.getByRole('button', { name: 'Use my name' }).click()
  for (const page of [a, b]) await expectNameEverywhere(page, 'Nineleven', 'Nine')
})

test('a server that was offline at the rename gets the new name on reconnect', async ({ browser }) => {
  test.setTimeout(120_000)
  const other = await startServer('Hideout')
  try {
    const a = await (await browser.newContext()).newPage()
    // A's connection goes through a switch that can drop it. The server still holds the old socket for a while (as
    // after a Wi-Fi drop), so A is "already online" when she reconnects with her new name.
    let down = false
    const open: WebSocketRoute[] = []
    await a.routeWebSocket(/\/ws$/, (ws) => {
      if (down) return void ws.close({ code: 1006, reason: 'network' }).catch(() => undefined)
      open.push(ws)
      ws.connectToServer()
    })
    await joinVia(a, other.ownerLink(), 'Cy')
    const b = await (await browser.newContext()).newPage()
    await joinVia(b, await createInviteLink(a), 'Di')
    await expect(b.locator('.member-list .member-name', { hasText: exactly('Cy') })).toHaveCount(1)

    // A loses the connection, renames, and comes back.
    down = true
    for (const ws of open.splice(0)) await ws.close({ code: 1006, reason: 'network' }).catch(() => undefined)
    await expect(a.locator('.pill.offline, .pill.connecting').first()).toBeVisible()
    await openSettings(a)
    await a.getByLabel('Name', { exact: true }).fill('Cyrus')
    await a.getByRole('button', { name: 'Save profile' }).click()
    await expect(a.getByText('Saved. Your name is updated everywhere.')).toBeVisible()
    await a.keyboard.press('Escape')
    await expect(b.locator('.member-list .member-name', { hasText: exactly('Cy') })).toHaveCount(1)
    down = false

    await expect(b.locator('.member-list .member-name', { hasText: exactly('Cyrus') })).toHaveCount(1, { timeout: 60_000 })
    await expect(a.locator('.member-list .member-name', { hasText: exactly('Cyrus') })).toHaveCount(1)
    await expect(a.locator('.me-bar')).toContainText('Cyrus')
  } finally {
    await other.stop()
  }
})
