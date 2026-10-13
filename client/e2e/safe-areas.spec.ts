import { join } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'
import { longPress, send, SHOTS, startServer, joinVia } from './helpers'

const { defaultBrowserType: _p, ...pixel } = devices['Pixel 7']

// The Android app draws edge to edge and Capacitor's SystemBars sets the system bar insets on <html> as
// --safe-area-inset-*; here the same variables stand in for a status bar and a 3-button navigation bar.
const TOP = 32
const BOTTOM = 48

async function setInsets(page: Page) {
  await page.evaluate(({ top, bottom }) => {
    const style = document.documentElement.style
    style.setProperty('--safe-area-inset-top', `${top}px`)
    style.setProperty('--safe-area-inset-bottom', `${bottom}px`)
    style.setProperty('--safe-area-inset-left', '0px')
    style.setProperty('--safe-area-inset-right', '0px')
  }, { top: TOP, bottom: BOTTOM })
}

/**
 * Every visible control (the part of it its scrolling ancestors don't clip) lies between the status bar and the
 * navigation bar. Returns the ones that don't, so a failure names them.
 */
async function covered(page: Page): Promise<string[]> {
  return page.evaluate(({ top, bottom }) => {
    const limit = window.innerHeight - bottom
    const bad: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [role="button"], [contenteditable="true"]')) {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || el.closest('[aria-hidden="true"], .skip-link')) continue
      const r = el.getBoundingClientRect()
      let y1 = r.top
      let y2 = r.bottom
      let x1 = r.left
      let x2 = r.right
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (s.overflowY !== 'visible' || s.overflowX !== 'visible') {
          const c = p.getBoundingClientRect()
          y1 = Math.max(y1, c.top); y2 = Math.min(y2, c.bottom); x1 = Math.max(x1, c.left); x2 = Math.min(x2, c.right)
        }
      }
      y1 = Math.max(y1, 0); y2 = Math.min(y2, window.innerHeight); x1 = Math.max(x1, 0); x2 = Math.min(x2, window.innerWidth)
      if (y2 - y1 < 1 || x2 - x1 < 1) continue // off screen, scrolled away or in a closed drawer
      if (y1 < top - 0.5 || y2 > limit + 0.5) {
        bad.push(`${el.tagName.toLowerCase()} "${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}" ${Math.round(y1)}–${Math.round(y2)}`)
      }
    }
    return bad
  }, { top: TOP, bottom: BOTTOM })
}

test('Android edge to edge: nothing sits under the status bar or the navigation bar', async ({ browser }) => {
  const server = await startServer('Insets')
  const context = await browser.newContext(pixel)
  const page = await context.newPage()
  await joinVia(page, server.ownerLink(), 'Ana')
  await setInsets(page)
  await send(page, 'Hello from the phone')

  // The channel: header (menu button) below the status bar, the message box above the navigation bar.
  const composer = page.getByRole('textbox', { name: /Message/ }).first()
  await expect(composer).toBeVisible()
  const height = page.viewportSize()!.height
  const box = (await composer.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(height - BOTTOM)
  const menu = (await page.getByRole('button', { name: 'Open channels' }).boundingBox())!
  expect(menu.y).toBeGreaterThanOrEqual(TOP)
  expect(await covered(page)).toEqual([])
  await page.screenshot({ path: join(SHOTS, 'safe-areas-channel.png'), animations: 'disabled' })

  // The channel drawer: its bottom row (your name, mute, deafen, settings) above the navigation bar.
  await page.getByRole('button', { name: 'Open channels' }).click()
  const settings = page.getByRole('button', { name: 'My settings', exact: true })
  await expect(settings).toBeVisible()
  await page.waitForTimeout(300) // the drawer slides in
  expect(((await settings.boundingBox())!).y + ((await settings.boundingBox())!).height).toBeLessThanOrEqual(height - BOTTOM)
  expect(await covered(page)).toEqual([])
  await page.screenshot({ path: join(SHOTS, 'safe-areas-drawer.png'), animations: 'disabled' })
  await page.locator('.scrim').click({ position: { x: 380, y: 400 } })

  // The members drawer.
  await page.getByRole('button', { name: 'Members' }).first().click()
  await page.waitForTimeout(300)
  expect(await covered(page)).toEqual([])
  await page.locator('.scrim').click({ position: { x: 20, y: 400 } })
  await page.waitForTimeout(300)

  // A message's action sheet.
  await longPress(page, page.locator('.message', { hasText: 'Hello from the phone' }).last())
  const sheet = page.locator('.action-sheet')
  await expect(sheet).toBeVisible()
  await page.waitForTimeout(300)
  expect(await covered(page)).toEqual([])
  await page.screenshot({ path: join(SHOTS, 'safe-areas-sheet.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // My settings (full screen on a phone).
  await page.getByRole('button', { name: 'Open channels' }).click()
  await page.getByRole('button', { name: 'My settings', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(await covered(page)).toEqual([])
  await page.screenshot({ path: join(SHOTS, 'safe-areas-settings.png'), animations: 'disabled' })

  await context.close()
  await server.stop()
})
