// Phones: back closes the top layer, then opens the channels drawer, then closes it; two quick backs leave. Sideways
// swipes move the channels drawer (right) and the member list (left), following the finger.
import { join } from 'node:path'
import { expect, test, type CDPSession, type Page } from '@playwright/test'
import { joinVia, longPress, send, SHOTS, startServer } from './helpers'

type Hooks = { __iskraNativeBack: () => void; __iskraExitHook?: () => void; __exits?: number }

/** A one-finger swipe from (x, y) by dx, dy, in steps. `pause` runs mid-way, finger still down. */
async function swipe(cdp: CDPSession, x: number, y: number, dx: number, dy = 0, opts: { steps?: number; stepMs?: number; pause?: () => Promise<void>; at?: number } = {}) {
  const steps = opts.steps ?? 12
  const point = (i: number) => [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(0) })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(i) })
    await new Promise((r) => setTimeout(r, opts.stepMs ?? 16))
    if (opts.pause && i === Math.round(steps * (opts.at ?? 0.5))) await opts.pause()
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const panel = (page: Page) => page.locator('.shell').evaluate((el) => [...el.classList].find((c) => c.startsWith('panel-')))
const settle = (page: Page) => page.waitForTimeout(350)

test('phone: back and swipes move between the chat, the channels and the members', async ({ browser }) => {
  const server = await startServer('Pocket Nav')
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    await joinVia(page, server.ownerLink(), 'Host')
    await send(page, 'hello from the phone')
    await send(page, 'with `some inline code` in it')
    await expect(page.locator('.message').filter({ hasText: 'some inline code' })).toBeVisible()
    const cdp = await context.newCDPSession(page)
    const nav = page.locator('.nav-column')
    const members = page.locator('.members-column')

    // Swipe right in the chat: the channels drawer follows the finger, then opens.
    await swipe(cdp, 40, 420, 260, 6, {
      stepMs: 30,
      pause: async () => {
        await expect.poll(() => nav.evaluate((el) => el.style.transform)).toMatch(/translateX\(-\d/)
        // The scrim fades in with the drawer.
        const scrim = await page.locator('.shell > .scrim').evaluate((el) => [getComputedStyle(el).display, Number(getComputedStyle(el).opacity)] as const)
        expect(scrim[0]).toBe('block')
        expect(scrim[1]).toBeGreaterThan(0.2)
        expect(scrim[1]).toBeLessThan(0.9)
        await page.screenshot({ path: join(SHOTS, 'phone-nav-swipe-mid.png') })
      },
    })
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await settle(page)
    await page.screenshot({ path: join(SHOTS, 'phone-nav-drawer.png') })
    // Swipe left on the drawer closes it.
    await swipe(cdp, 300, 420, -240, 0, { stepMs: 30 })
    await expect.poll(() => panel(page)).toBe('panel-none')

    // A short, slow swipe snaps back; a mostly-down move scrolls instead; code keeps its own sideways moves.
    await swipe(cdp, 40, 420, 60, 0, { stepMs: 60 })
    await settle(page)
    expect(await panel(page)).toBe('panel-none')
    expect(await nav.evaluate((el) => el.style.transform)).toBe('')
    await swipe(cdp, 60, 300, 40, 200)
    await settle(page)
    expect(await panel(page)).toBe('panel-none')
    const code = (await page.locator('.message code').first().boundingBox())!
    await swipe(cdp, code.x + 4, code.y + code.height / 2, 250, 0)
    await settle(page)
    expect(await panel(page)).toBe('panel-none')

    // Swipe left: the member list (Discord-like); swipe right puts it away.
    await swipe(cdp, 350, 420, -240, 0, {
      stepMs: 30,
      pause: async () => {
        await page.screenshot({ path: join(SHOTS, 'phone-nav-members-mid.png') })
      },
    })
    await expect.poll(() => panel(page)).toBe('panel-members')
    await expect(members.getByText('Host').first()).toBeVisible()
    await settle(page)
    await page.screenshot({ path: join(SHOTS, 'phone-nav-members.png') })
    // Back closes it too.
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-none')

    // Press and hold still opens a message's sheet; back closes the sheet, not anything under it.
    await longPress(page, page.locator('.message').filter({ hasText: 'hello from the phone' }).locator('.message-body'))
    const sheet = page.locator('.action-sheet')
    await expect(sheet).toBeVisible()
    await page.goBack()
    await expect(sheet).toHaveCount(0)
    expect(await panel(page)).toBe('panel-none')

    // Browser back in a channel opens the drawer (focus moves into it); back again returns to the channel.
    const before = await page.evaluate(() => history.length)
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-nav')
    expect(await nav.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-none')
    await expect(page.getByRole('status').filter({ hasText: 'Press back again to leave' })).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(SHOTS, 'phone-nav-back-hint.png') })
    expect(await nav.evaluate((el) => el.contains(document.activeElement))).toBe(false)
    // The hint goes; back then opens the drawer again rather than leaving. No pile of history entries either.
    await expect(page.getByText('Press back again to leave')).toHaveCount(0, { timeout: 4000 })
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await page.keyboard.press('Escape')
    await expect.poll(() => panel(page)).toBe('panel-none')
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 1)

    // The phone app's back button (Capacitor's backButton event): same steps; two quick backs on the drawer leave.
    await page.evaluate(() => {
      const w = window as unknown as Hooks
      w.__exits = 0
      w.__iskraExitHook = () => { w.__exits = (w.__exits ?? 0) + 1 }
    })
    const nativeBack = () => page.evaluate(() => (window as unknown as Hooks).__iskraNativeBack())
    const exits = () => page.evaluate(() => (window as unknown as Hooks).__exits)
    await longPress(page, page.locator('.message').filter({ hasText: 'hello from the phone' }).locator('.message-body'))
    await expect(sheet).toBeVisible()
    await nativeBack()
    await expect(sheet).toHaveCount(0)
    await nativeBack()
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await nativeBack()
    await expect.poll(() => panel(page)).toBe('panel-none')
    expect(await exits()).toBe(0)
    await nativeBack()
    expect(await exits()).toBe(1)
    expect(await panel(page)).toBe('panel-none')
  } finally {
    await server.stop()
  }
})

test('phone: reduced motion still swipes, without the drawer following the finger', async ({ browser }) => {
  const server = await startServer('Still Nav')
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await joinVia(page, server.ownerLink(), 'Host')
    const cdp = await context.newCDPSession(page)
    const nav = page.locator('.nav-column')
    await swipe(cdp, 40, 420, 260, 0, {
      stepMs: 30,
      pause: async () => {
        expect(await nav.evaluate((el) => el.style.transform)).toBe('')
      },
    })
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await swipe(cdp, 300, 420, -240, 0, { stepMs: 30 })
    await expect.poll(() => panel(page)).toBe('panel-none')
  } finally {
    await server.stop()
  }
})
