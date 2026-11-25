import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { composerAction, createInviteLink, hasLiveKit, joinVia, longPress, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let one: TestServer
let two: TestServer
test.beforeAll(async () => {
  one = await startServer('Alpha Club')
  two = await startServer('Beta Club')
})
test.afterAll(async () => {
  await one?.stop()
  await two?.stop()
})

/** Joins a second server from a page that is already signed in. */
async function alsoJoin(page: Page, link: string, name: string) {
  await page.goto(link)
  await page.getByRole('button', { name: 'Join server' }).click()
  await expect(page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible({ timeout: 15_000 })
}

const railIcon = (page: Page, name: string) => page.locator(`.server-icon[title="${name}"]`)

test('several servers are muted and unmuted together', async ({ browser }) => {
  test.setTimeout(120_000)
  const me = await (await browser.newContext()).newPage()
  await joinVia(me, one.ownerLink(), 'Viktor')
  await alsoJoin(me, two.ownerLink(), 'Beta Club')
  await expect(railIcon(me, 'Alpha Club')).toBeVisible()
  await expect(railIcon(me, 'Beta Club')).toBeVisible()

  // From a server's menu: Notifications → Mute several servers…, with that server already ticked.
  await railIcon(me, 'Alpha Club').click({ button: 'right' })
  await me.getByRole('menuitem', { name: /^Notifications/ }).click()
  await me.getByRole('menuitem', { name: 'Mute several servers…' }).click()
  const dialog = me.getByRole('dialog', { name: 'Mute servers' })
  await expect(dialog.getByRole('checkbox', { name: /Alpha Club/ })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: /Beta Club/ })).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Mute', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Select all' }).click()
  await expect(dialog.getByRole('checkbox', { name: /Beta Club/ })).toBeChecked()
  await expect(dialog.getByLabel('Mute for how long').locator('option')).toHaveText(['For 15 minutes', 'For 1 hour', 'For 8 hours', 'For 24 hours', 'Until I turn it back on'])
  await dialog.getByLabel('Mute for how long').selectOption({ label: 'For 1 hour' })
  await me.screenshot({ path: join(SHOTS, 'mute-servers.png') })
  await dialog.getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // Both servers say so in their own menus, and it survives a reload (each server keeps its own mute).
  for (const name of ['Alpha Club', 'Beta Club']) {
    await railIcon(me, name).click({ button: 'right' })
    await expect(me.getByRole('menuitem', { name: /^Notifications/ })).toContainText('Server is muted')
    await me.keyboard.press('Escape')
  }
  await me.reload()
  await expect(railIcon(me, 'Beta Club')).toBeVisible({ timeout: 15_000 })

  // From My settings → Notifications: the list shows what is muted; unmute one of them.
  await openSettings(me, 'Notifications')
  await me.getByTestId('mute-servers-entry').getByRole('button', { name: 'Mute several servers…' }).click()
  await expect(dialog.locator('li', { hasText: 'Alpha Club' })).toContainText(/Muted until/)
  await expect(dialog.locator('li', { hasText: 'Beta Club' })).toContainText(/Muted until/)
  await expect(dialog.getByRole('button', { name: 'Unmute', exact: true })).toBeDisabled() // nothing ticked yet
  await dialog.getByRole('checkbox', { name: /Beta Club/ }).check()
  await dialog.getByRole('button', { name: 'Unmute', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await me.keyboard.press('Escape')
  await railIcon(me, 'Beta Club').click({ button: 'right' })
  await expect(me.getByRole('menuitem', { name: /^Notifications/ })).not.toContainText('Server is muted')
  await me.keyboard.press('Escape')
  await railIcon(me, 'Alpha Club').click({ button: 'right' })
  await expect(me.getByRole('menuitem', { name: /^Notifications/ })).toContainText('Server is muted')
  await me.keyboard.press('Escape')
})

test('hidden buttons leave the screen and stay reachable from the menus', async ({ browser }) => {
  test.setTimeout(120_000)
  const world = await startServer('Tidy Test')
  try {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, world.ownerLink(), 'Host')
    const composer = host.locator('.composer')
    const header = host.locator('.chat-header .header-tools')
    await expect(composer.getByRole('button', { name: 'GIFs', exact: true })).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Emoji', exact: true })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Threads', exact: true })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Pinned messages', exact: true })).toBeVisible()
    await host.screenshot({ path: join(SHOTS, 'declutter-before.png') })

    // My settings → Appearance → Hide buttons I don't use.
    await openSettings(host, 'Appearance')
    const section = host.getByTestId('hidden-buttons')
    await expect(section.getByRole('heading', { name: "Hide buttons I don't use" })).toBeVisible()
    // Only optional buttons are listed: nothing for Send, attaching files, mute, deafen or leaving a call.
    await expect(section.getByRole('switch')).toHaveCount(8)
    for (const essential of [/Send/, /Attach/, /Mute/, /Deafen/, /Leave/]) await expect(section.getByRole('switch', { name: essential })).toHaveCount(0)
    for (const name of ['Hide: GIFs', 'Hide: Emoji', 'Hide: Record a voice message', 'Hide: Threads', 'Hide: Pinned messages', 'Hide: Search messages'])
      await section.getByRole('switch', { name, exact: true }).check()
    await section.scrollIntoViewIfNeeded()
    await host.screenshot({ path: join(SHOTS, 'declutter-settings.png') })
    await host.keyboard.press('Escape')

    // The composer row is "+", the box and Send; the header keeps ⋯ and members.
    await expect(composer.getByRole('button', { name: 'GIFs', exact: true })).toHaveCount(0)
    await expect(composer.getByRole('button', { name: 'Emoji', exact: true })).toHaveCount(0)
    await expect(composer.getByRole('button', { name: 'Record a voice message' })).toBeHidden()
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Add to your message' })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Threads', exact: true })).toHaveCount(0)
    await expect(header.getByRole('button', { name: 'Pinned messages', exact: true })).toHaveCount(0)
    await expect(header.getByLabel('Search messages')).toHaveCount(0)
    await host.screenshot({ path: join(SHOTS, 'declutter-after.png') })

    // Everything is still there: emoji and GIFs from "+", threads, pins and search from the channel's ⋯ menu.
    await composerAction(host, 'Emoji')
    await expect(host.getByRole('dialog', { name: 'Emoji picker' })).toBeVisible()
    await host.keyboard.press('Escape')
    await composer.getByRole('button', { name: 'Add to your message' }).click()
    await expect(host.getByRole('menuitem', { name: 'GIFs', exact: true })).toBeVisible()
    await expect(host.getByRole('menuitem', { name: 'Record a voice message', exact: true })).toBeVisible()
    await expect(host.getByRole('menuitem', { name: 'Attach files', exact: true })).toBeVisible()
    await host.keyboard.press('Escape')
    await host.getByTestId('header-more').click()
    await expect(host.getByRole('menuitem', { name: 'Threads', exact: true })).toBeVisible()
    await expect(host.getByRole('menuitem', { name: 'Search messages', exact: true })).toBeVisible()
    await host.getByRole('menuitem', { name: 'Pinned messages', exact: true }).click()
    await expect(host.getByText(/Pinned in/)).toBeVisible()
    await host.keyboard.press('Escape')

    // It is kept on this device across a reload, and "Show all buttons again" brings them back.
    await host.reload()
    await expect(host.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(composer.getByRole('button', { name: 'GIFs', exact: true })).toHaveCount(0)
    await openSettings(host, 'Appearance')
    await section.getByRole('button', { name: 'Show all buttons again' }).click()
    await host.keyboard.press('Escape')
    await expect(composer.getByRole('button', { name: 'GIFs', exact: true })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Threads', exact: true })).toBeVisible()
  } finally {
    await world.stop()
  }
})

test('the call buttons of a direct message move into its menu, and the phone layout shows the same settings', async ({ browser }) => {
  test.setTimeout(120_000)
  // Calls need voice on the server: without LiveKit in .tools the call entries are not offered anywhere.
  const world = await startServer('Tidy Calls Test', hasLiveKit())
  try {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, world.ownerLink(), 'Host')
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
    await joinVia(phone, await createInviteLink(host), 'Mia')

    // Host opens a DM with Mia: two call buttons in the header.
    await host.locator('.member-list .member', { hasText: 'Mia' }).click({ button: 'right' })
    await host.getByRole('menuitem', { name: 'Message' }).click()
    const tools = host.locator('.dm-header .header-tools')
    await expect(tools.getByRole('button', { name: 'Start voice call' })).toBeVisible()
    await expect(tools.getByRole('button', { name: 'Start video call' })).toBeVisible()

    await openSettings(host, 'Appearance')
    await host.getByTestId('hidden-buttons').getByRole('switch', { name: 'Hide: Voice call and video call', exact: true }).check()
    await host.keyboard.press('Escape')
    await expect(tools.getByRole('button', { name: 'Start voice call' })).toHaveCount(0)
    await expect(tools.getByRole('button', { name: 'Start video call' })).toHaveCount(0)
    await tools.getByTestId('header-more').click()
    await expect(host.getByRole('menuitem', { name: 'Verify safety number' })).toBeVisible()
    if (hasLiveKit()) {
      await expect(host.getByRole('menuitem', { name: 'Start voice call' })).toBeVisible()
      await expect(host.getByRole('menuitem', { name: 'Start video call' })).toBeVisible()
    }
    await host.keyboard.press('Escape')

    // On a phone: the same switches, and the mute dialog is a sheet opened from a long press on the server.
    await phone.getByRole('button', { name: 'Open channels' }).first().click()
    await openSettings(phone, 'Appearance')
    const section = phone.getByTestId('hidden-buttons')
    await section.scrollIntoViewIfNeeded()
    await expect(section.getByRole('switch', { name: 'Hide: Emoji', exact: true })).toBeVisible()
    await phone.screenshot({ path: join(SHOTS, 'declutter-settings-phone.png') })
    // Back out of the section, then out of settings (the phone shows them as two pages).
    const settings = phone.getByRole('dialog', { name: 'Settings' })
    for (let i = 0; i < 3 && (await settings.count()) > 0; i++) await phone.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    if (!(await railIcon(phone, 'Tidy Calls Test').isVisible())) await phone.getByRole('button', { name: 'Open channels' }).first().click()
    await longPress(phone, railIcon(phone, 'Tidy Calls Test'))
    await phone.getByRole('menuitem', { name: /^Notifications/ }).click()
    await phone.getByRole('menuitem', { name: 'Mute several servers…' }).click()
    const dialog = phone.getByRole('dialog', { name: 'Mute servers' })
    await expect(dialog.getByRole('checkbox', { name: /Tidy Calls Test/ })).toBeChecked()
    await phone.screenshot({ path: join(SHOTS, 'mute-servers-phone.png') })
    await dialog.getByRole('button', { name: 'Mute', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  } finally {
    await world.stop()
  }
})
