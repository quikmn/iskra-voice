// Phones: things a finger and a small screen need. Tap targets a finger can hit (44 px), a call that leaves room for
// the conversation, and a sideways phone whose notch covers nothing.
import { join } from 'node:path'
import { devices, expect, test, type Locator, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, longPress, send, SHOTS, startServer } from './helpers'

const { defaultBrowserType: _p, ...pixel } = devices['Pixel 7']
/** A small phone (360 × 640), as many Android phones still are. */
const small = { ...pixel, viewport: { width: 360, height: 640 }, screen: { width: 360, height: 640 } }

/**
 * How tall the strip a finger can hit is at the middle of a control: the control itself plus what its invisible
 * ::before adds above and below (ui/kit/kit.css), as far as nothing else lies on top.
 */
async function tapHeight(target: Locator): Promise<number> {
  await target.scrollIntoViewIfNeeded()
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const hit = (py: number) => {
      const at = document.elementFromPoint(x, py)
      return !!at && (el === at || el.contains(at))
    }
    let up = 0
    while (up < 40 && hit(y - up - 1)) up++
    let down = 0
    while (down < 40 && hit(y + down + 1)) down++
    return up + down + 1 // whole pixels: a 44 px strip can count as 43
  })
}

async function setInsets(page: Page, insets: { top?: number; bottom?: number; left?: number; right?: number }) {
  await page.evaluate((i) => {
    const style = document.documentElement.style
    for (const side of ['top', 'bottom', 'left', 'right'] as const) style.setProperty(`--safe-area-inset-${side}`, `${i[side] ?? 0}px`)
  }, insets)
}

test('phone: buttons, tabs, channel rows and small links are 44 px to a finger', async ({ browser }) => {
  const server = await startServer('Fingers')
  try {
    const context = await browser.newContext(pixel)
    const page = await context.newPage()
    await joinVia(page, server.ownerLink(), 'Ana')
    await send(page, 'pin me')

    // The channel list: every row is a full finger tall.
    await page.getByRole('button', { name: 'Open channels' }).click()
    const rows = page.locator('.channel-list .channel')
    await expect(rows.first()).toBeVisible()
    await page.waitForTimeout(300) // the drawer slides in
    for (const row of await rows.all()) expect((await row.boundingBox())!.height, await row.innerText()).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: join(SHOTS, 'phone-polish-drawer.png'), animations: 'disabled' })

    // A dialog: its type switch and its buttons.
    await page.getByRole('button', { name: 'Create channel' }).first().click()
    const create = page.getByRole('dialog', { name: 'Create channel' })
    await expect(create).toBeVisible()
    await page.waitForTimeout(300)
    expect(await tapHeight(create.getByRole('radio', { name: 'Voice' }))).toBeGreaterThanOrEqual(43)
    expect(await tapHeight(create.getByRole('button', { name: 'Cancel' }))).toBeGreaterThanOrEqual(43)
    await create.getByRole('button', { name: 'Cancel' }).click()
    await expect(create).toHaveCount(0)

    // The emoji picker's category tabs.
    await page.locator('.channel-list .channel', { hasText: 'general' }).click()
    await page.locator('.composer').getByRole('button', { name: 'Add to your message' }).click()
    await page.getByRole('menuitem', { name: 'Emoji', exact: true }).click()
    const category = page.locator('.emoji-tabs button').first()
    await expect(category).toBeVisible()
    await page.waitForTimeout(300)
    expect((await category.boundingBox())!.height).toBeGreaterThanOrEqual(40)
    await page.keyboard.press('Escape')
    await expect(category).toBeHidden()

    // Friends: the tabs.
    await page.getByRole('button', { name: 'Open channels' }).click()
    await page.getByRole('button', { name: 'Direct messages' }).click()
    const tab = page.locator('.friends-tab').first()
    await expect(tab).toBeVisible()
    await page.waitForTimeout(300)
    expect(await tapHeight(tab)).toBeGreaterThanOrEqual(43)
    await context.close()
  } finally {
    await server.stop()
  }
})

test('a sideways phone: settings and toasts keep clear of the notch', async ({ browser }) => {
  const server = await startServer('Sideways')
  try {
    const context = await browser.newContext({ ...pixel, viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } })
    const page = await context.newPage()
    await joinVia(page, server.ownerLink(), 'Ana')
    await setInsets(page, { left: 47, right: 47, bottom: 21 })
    await page.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    await page.waitForTimeout(300)
    const width = page.viewportSize()!.width
    for (const control of [dialog.getByRole('button', { name: 'Close' }), dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Profile', exact: true })]) {
      const box = (await control.boundingBox())!
      expect(box.x, 'clear of the left inset').toBeGreaterThanOrEqual(47)
      expect(box.x + box.width, 'clear of the right inset').toBeLessThanOrEqual(width - 47)
    }
    await page.screenshot({ path: join(SHOTS, 'phone-polish-landscape-settings.png'), animations: 'disabled' })
    await context.close()
  } finally {
    await server.stop()
  }
})

test.describe('in a call', () => {
  test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

  test('small phone: answering shows the call, and it leaves the message box on screen, also with the keyboard open', async ({ browser }) => {
    test.setTimeout(120_000)
    const server = await startServer('Small call', true, { Calls__RingTimeoutMs: '60000' })
    try {
      const phone = await (await browser.newContext({ ...small, permissions: ['microphone', 'camera'] })).newPage()
      await joinVia(phone, server.ownerLink(), 'Host')
      const friend = await (await browser.newContext()).newPage()
      await phone.getByRole('button', { name: 'Open channels' }).click()
      await joinVia(friend, await createInviteLink(phone), 'Friend')

      // The friend calls with the camera on; the phone answers.
      await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
      await friend.getByRole('button', { name: 'Add friend' }).click()
      await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
      await friend.getByRole('button', { name: 'Start video call' }).click()
      await phone.getByRole('alertdialog').getByRole('button', { name: 'Accept' }).click()
      // The channels drawer was open behind the ringing screen: answering closes it, so the call shows.
      await expect(phone.locator('.shell')).toHaveClass(/panel-none/)
      const panel = phone.locator('.call-panel')
      await expect(panel.locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
      await expect(panel.locator('.video-tile video').first()).toBeVisible({ timeout: 15_000 })

      // A status bar and a 3-button navigation bar.
      await setInsets(phone, { top: 24, bottom: 48 })
      const composer = phone.locator('.composer')
      const fits = async (height: number, bottomInset: number, wholeControls: boolean) => {
        const box = (await composer.boundingBox())!
        expect(box.y + box.height, 'the message box ends above the navigation bar').toBeLessThanOrEqual(height - bottomInset + 0.5)
        const messages = (await phone.locator('.chat > .messages').boundingBox())!
        expect(messages.height, 'some of the conversation shows').toBeGreaterThanOrEqual(60)
        if (!wholeControls) return
        // The call's controls are still there, whole.
        const hangUp = (await panel.getByRole('button', { name: 'Hang up' }).boundingBox())!
        const panelBox = (await panel.boundingBox())!
        expect(hangUp.y + hangUp.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 0.5)
      }
      await phone.waitForTimeout(300)
      await phone.screenshot({ path: join(SHOTS, 'phone-polish-call-small.png'), animations: 'disabled' })
      await fits(640, 48, true)

      // The keyboard takes the lower part of the screen (the web view shrinks; the bottom inset goes).
      await phone.setViewportSize({ width: 360, height: 380 })
      await setInsets(phone, { top: 24, bottom: 0 })
      await phone.waitForTimeout(300)
      await phone.screenshot({ path: join(SHOTS, 'phone-polish-call-keyboard.png'), animations: 'disabled' })
      // With a friend request and the recovery reminder above it, the call is what gets cut.
      await fits(380, 0, false)
    } finally {
      await server.stop()
    }
  })
})

/** How far the message list is from its newest message, in px. */
const fromBottom = (page: Page) => page.locator('.messages').evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))

test('small phone: the newest message stays in view while a long message is typed, sent, and when the keyboard opens', async ({ browser }) => {
  const server = await startServer('Newest')
  try {
    const phone = await (await browser.newContext(small)).newPage()
    await joinVia(phone, server.ownerLink(), 'Host')
    const lines = ['one', 'two', 'three', 'four', 'five'].join(String.fromCharCode(10))

    // A channel: the message box grows by four lines; the list follows, and the sent message shows.
    for (let i = 0; i < 12; i++) await send(phone, `message ${i} with enough words to wrap on a small phone screen`)
    await expect(phone.locator('.message', { hasText: 'message 11' })).toBeVisible()
    const channelBox = phone.getByPlaceholder('Message #general')
    await channelBox.fill(lines)
    await expect.poll(() => fromBottom(phone)).toBeLessThanOrEqual(2)
    await channelBox.press('Enter')
    await expect(phone.locator('.message', { hasText: 'five' })).toBeVisible()
    await expect.poll(() => fromBottom(phone)).toBeLessThanOrEqual(2)
    await expect(phone.locator('.message', { hasText: 'five' })).toBeInViewport({ ratio: 1 })

    // A direct message: the same box grows there too, and the list follows it and the keyboard.
    const friend = await (await browser.newContext()).newPage()
    await phone.getByRole('button', { name: 'Open channels' }).click()
    await joinVia(friend, await createInviteLink(phone), 'Friend')
    await phone.locator('.scrim').click({ position: { x: 350, y: 300 } })
    await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
    await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
    const friendBox = friend.getByPlaceholder('Message Host')
    for (let i = 0; i < 10; i++) {
      await friendBox.fill(`direct ${i} with enough words to wrap on a small phone screen`)
      await friendBox.press('Enter')
      await expect(friendBox).toHaveValue('')
    }
    await phone.getByRole('button', { name: 'Open channels' }).click()
    await phone.getByRole('button', { name: 'Direct messages' }).click()
    await phone.getByRole('button', { name: 'Open menu' }).click()
    await phone.locator('.dm-row', { hasText: 'Friend' }).click()
    await expect(phone.getByRole('article').filter({ hasText: 'direct 9' })).toBeVisible()
    await expect.poll(() => fromBottom(phone)).toBeLessThanOrEqual(2)
    const dmBox = phone.getByPlaceholder('Message Friend')
    const oneLine = (await dmBox.boundingBox())!.height
    await dmBox.fill(lines)
    expect((await dmBox.boundingBox())!.height, 'the box shows all five lines').toBeGreaterThan(oneLine * 3)
    await expect.poll(() => fromBottom(phone)).toBeLessThanOrEqual(2)
    await phone.screenshot({ path: join(SHOTS, 'phone-polish-dm-typing.png'), animations: 'disabled' })
    // The keyboard opens: the web view gets shorter.
    await phone.setViewportSize({ width: 360, height: 380 })
    await expect.poll(() => fromBottom(phone)).toBeLessThanOrEqual(2)
    await dmBox.press('Enter')
    await expect(phone.getByRole('article').filter({ hasText: 'five' })).toBeVisible()
    await expect.poll(() => fromBottom(phone)).toBeLessThanOrEqual(2)
    expect((await dmBox.boundingBox())!.height, 'back to one line').toBeLessThanOrEqual(oneLine + 1)
  } finally {
    await server.stop()
  }
})

test("small phone: a message's sheet scrolls, it doesn't cut rows out of its groups", async ({ browser }) => {
  const server = await startServer('Sheet')
  try {
    const phone = await (await browser.newContext(small)).newPage()
    await joinVia(phone, server.ownerLink(), 'Host')
    await send(phone, 'hold me')
    await expect(phone.locator('.message.sending')).toHaveCount(0) // the row is redrawn when the server confirms it
    await longPress(phone, phone.locator('.message', { hasText: 'hold me' }).last())
    const sheet = phone.locator('.action-sheet')
    await expect(sheet).toBeVisible()
    await phone.waitForTimeout(300)
    // Every group is as tall as its rows: none is squeezed with a row hidden inside it.
    const squeezed = await sheet.locator('.org-group').evaluateAll((groups) => groups.filter((g) => g.scrollHeight > g.clientHeight + 1).map((g) => g.textContent))
    expect(squeezed).toEqual([])
    // The rows a squeezed sheet lost: they are there, and the last one scrolls into view.
    await expect(sheet.getByRole('menuitem', { name: 'Forward' })).toBeVisible()
    const last = sheet.getByRole('menuitem').last()
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport({ ratio: 1 })
    await phone.screenshot({ path: join(SHOTS, 'phone-polish-message-sheet.png'), animations: 'disabled' })
  } finally {
    await server.stop()
  }
})
