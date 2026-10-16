// The desktop frame: the channel list, the chat column and the members list sit as rounded panels on the dark base
// (--rail), with a thin gutter between them, along the bottom and along the right edge, flush with the top. The me bar
// and the message box share one height and one bottom edge. Phones stay full-bleed. Measured, not eyeballed: the
// numbers go to e2e/screenshots/layout-frame.json next to the screenshots.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Frame Crew')
})
test.afterAll(async () => server?.stop())

/** The gutter between the panels and around them (styles.css --frame-gap). */
const GAP = 8
const DESKTOP = { width: 1280, height: 720 }
const PHONE = { width: 390, height: 844 }

interface Box { x: number; y: number; w: number; h: number; right: number; bottom: number }
type Rgb = [number, number, number]
/** What's painted in the outermost pixel of each corner of a panel. */
interface Corners { topLeft: Rgb; topRight: Rgb; bottomLeft: Rgb; bottomRight: Rgb }

const rgb = (css: string | null): Rgb => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1]
}

/**
 * Bounding boxes of the panels and the bottom bars, the colour of the pixel in each corner of each panel (from a
 * screenshot, decoded in the page on a canvas), and the base colours. A rounded corner shows the base behind the
 * panel; anything painted over it (a child with its own background) shows up here too.
 */
async function measure(page: Page) {
  const shot = (await page.screenshot({ animations: 'disabled' })).toString('base64')
  return page.evaluate(async (shot) => {
    const box = (sel: string): Box | null => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
    }
    const style = (sel: string, prop: string) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).getPropertyValue(prop) : null
    }
    const img = new Image()
    await new Promise((ok, fail) => {
      img.onload = ok
      img.onerror = fail
      img.src = `data:image/png;base64,${shot}`
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const scale = img.naturalWidth / window.innerWidth
    const pixel = (x: number, y: number): Rgb => {
      const d = ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data
      return [d[0], d[1], d[2]]
    }
    const corners = (sel: string): Corners | null => {
      const b = box(sel)
      if (!b) return null
      return { topLeft: pixel(b.x, b.y), topRight: pixel(b.right - 1, b.y), bottomLeft: pixel(b.x, b.bottom - 1), bottomRight: pixel(b.right - 1, b.bottom - 1) }
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      sidebar: box('.channel-sidebar'), main: box('.main-column'), members: box('.members-column'),
      meBar: box('.me-bar'), composer: box('.composer'),
      corners: { sidebar: corners('.channel-sidebar'), main: corners('.main-column'), members: corners('.members-column') },
      radius: { sidebar: style('.channel-sidebar', 'border-radius'), main: style('.main-column', 'border-radius'), members: style('.members-column', 'border-radius') },
      colors: {
        shell: style('.shell', 'background-color'), rail: style('.nav-column', 'background-color'),
        sidebar: style('.channel-sidebar', 'background-color'), main: style('.main-column', 'background-color'), members: style('.members-column', 'background-color'),
      },
    }
  }, shot)
}
type Measured = Awaited<ReturnType<typeof measure>>

// Merged into the file: after a failure Playwright finishes the file in a fresh worker, whose afterAll runs too.
const report: Record<string, Measured> = {}
test.afterAll(() => {
  const file = join(SHOTS, 'layout-frame.json')
  const before = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Measured>) : {}
  writeFileSync(file, JSON.stringify({ ...before, ...report }, null, 2))
})

const near = (what: string, actual: number, wanted: number, tolerance = 1) =>
  expect(Math.abs(actual - wanted), `${what}: ${actual} should be ${wanted} (±${tolerance})`).toBeLessThanOrEqual(tolerance)
const sameColor = (what: string, actual: Rgb, wanted: Rgb) =>
  expect(actual.every((c, i) => Math.abs(c - wanted[i]) <= 2), `${what}: rgb(${actual}) should be rgb(${wanted})`).toBe(true)

/** The base shows in every corner of the panel: nothing square is painted over them. */
function expectRounded(what: string, corners: Corners | null, base: Rgb) {
  expect(corners, what).toBeTruthy()
  for (const [corner, color] of Object.entries(corners!)) sameColor(`${what} ${corner}`, color, base)
}

/** The three panels on the base, 8px apart, 8px off the bottom and the right edge, flush with the top, every corner rounded. */
function expectFrame(m: Measured) {
  const { sidebar, main, members, viewport } = m
  expect(sidebar && main && members).toBeTruthy()
  near('sidebar top', sidebar!.y, 0)
  near('main top', main!.y, 0)
  near('members top', members!.y, 0)
  near('gutter sidebar | main', main!.x - sidebar!.right, GAP)
  near('gutter main | members', members!.x - main!.right, GAP)
  near('gutter right of members', viewport.w - members!.right, GAP)
  near('gutter under sidebar', viewport.h - sidebar!.bottom, GAP)
  near('gutter under main', viewport.h - main!.bottom, GAP)
  near('gutter under members', viewport.h - members!.bottom, GAP)
  // The base between the panels is the rail's colour, whatever the theme, and it shows in every corner.
  expect(m.colors.shell).toBe(m.colors.rail)
  const base = rgb(m.colors.rail)
  expectRounded('sidebar', m.corners.sidebar, base)
  expectRounded('main column', m.corners.main, base)
  expectRounded('members column', m.corners.members, base)
}

/** The me bar and the message box: one height, one bottom edge. */
function expectBarsAligned(m: Measured) {
  expect(m.meBar && m.composer).toBeTruthy()
  near('me bar height vs composer height', m.meBar!.h, m.composer!.h)
  near('me bar bottom vs composer bottom', m.meBar!.bottom, m.composer!.bottom)
}

test('desktop: rounded panels on the base, bottom bars aligned, in three themes', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  await joinVia(page, server.ownerLink(), 'Host')
  // A members list with two people and a few messages, so the panels have something in them.
  const friend = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  await joinVia(friend, await createInviteLink(page), 'Friend')
  await send(friend, 'The frame should go all the way round.')
  await send(page, 'Rounded corners at the bottom too, with the dark base showing under them.')
  await expect(page.locator('.message-text', { hasText: 'all the way round' })).toBeVisible()
  await expect(page.locator('.members-column .member', { hasText: 'Friend' })).toBeVisible()
  await page.mouse.move(DESKTOP.width / 2, 60) // off the message box and the bars
  await page.waitForTimeout(300)

  const desktop = await measure(page)
  report.desktop = desktop
  await page.screenshot({ path: join(SHOTS, 'layout-frame-desktop.png'), animations: 'disabled' })
  // The two corners that matter most: where the chat column's bottom meets the sidebar and the members list.
  const { sidebar, members } = desktop
  await page.screenshot({
    path: join(SHOTS, 'layout-frame-bottom.png'), animations: 'disabled',
    clip: { x: sidebar!.right - 40, y: DESKTOP.height - 140, width: members!.x + 40 - (sidebar!.right - 40), height: 140 },
  })
  expectFrame(desktop)
  expectBarsAligned(desktop)

  // Two other themes (one small radius, one large): the gutter and the corners come from the variables.
  for (const [name, file] of [['Nord', 'nord'], ['Synthwave 1984', 'synthwave']] as const) {
    await openSettings(page, 'Appearance')
    await page.getByRole('radio', { name, exact: true }).click()
    await page.keyboard.press('Escape')
    await page.mouse.move(DESKTOP.width / 2, 60)
    await page.waitForTimeout(300)
    const themed = await measure(page)
    report[`desktop-${file}`] = themed
    await page.screenshot({ path: join(SHOTS, `layout-frame-theme-${file}.png`), animations: 'disabled' })
    expectFrame(themed)
    expectBarsAligned(themed)
    expect(themed.radius.main).not.toBe(desktop.radius.main)
    expect(themed.colors.rail).not.toBe(desktop.colors.rail)
  }

  // Without a members list (a thread panel takes its place), the main column keeps its right corners.
  await openSettings(page, 'Appearance')
  await page.getByRole('radio', { name: 'Iskra (default)', exact: true }).click()
  await page.keyboard.press('Escape')
  const root = page.locator('.message', { hasText: 'all the way round' })
  await root.hover()
  await root.getByRole('button', { name: 'Start a thread' }).click()
  await page.getByLabel('Thread name').fill('Corners')
  await page.getByRole('button', { name: 'Create thread' }).click()
  await expect(page.locator('.thread-panel').getByRole('heading', { name: 'Corners' })).toBeVisible()
  await page.mouse.move(DESKTOP.width / 2, 60)
  await page.waitForTimeout(300)
  const withPanel = await measure(page)
  report['desktop-thread-panel'] = withPanel
  await page.screenshot({ path: join(SHOTS, 'layout-frame-thread-panel.png'), animations: 'disabled' })
  expect(withPanel.members?.w ?? 0, 'the members column is hidden').toBe(0)
  near('gutter right of main (no members list)', withPanel.viewport.w - withPanel.main!.right, GAP)
  expectRounded('main column without a members list', withPanel.corners.main, rgb(withPanel.colors.rail))

  // Home (no server open, so the shell has no members column at all): the same frame, two panels wide.
  await page.locator('.server-icon.home').click()
  await expect(page.locator('.channel-sidebar .me-bar')).toBeVisible()
  await page.mouse.move(DESKTOP.width / 2, 60)
  await page.waitForTimeout(300)
  const home = await measure(page)
  report['desktop-home'] = home
  await page.screenshot({ path: join(SHOTS, 'layout-frame-home.png'), animations: 'disabled' })
  expect(home.members).toBeNull()
  near('home: gutter sidebar | main', home.main!.x - home.sidebar!.right, GAP)
  near('home: gutter right of main', home.viewport.w - home.main!.right, GAP)
  near('home: gutter under main', home.viewport.h - home.main!.bottom, GAP)
  expectRounded('home: sidebar', home.corners.sidebar, rgb(home.colors.rail))
  expectRounded('home: main column', home.corners.main, rgb(home.colors.rail))
})

test('phone: full-bleed, no gutters, the drawer as before', async ({ browser }) => {
  // Its own server: the owner link above is used up once the host has joined.
  const phoneServer = await startServer('Frame Phone')
  const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await joinVia(page, phoneServer.ownerLink(), 'Phone')
  await expect(page.getByRole('button', { name: 'Open channels' })).toBeVisible()
  await page.waitForTimeout(300)
  const phone = await measure(page)
  report.phone = phone
  await page.screenshot({ path: join(SHOTS, 'layout-frame-phone.png'), animations: 'disabled' })
  near('main left', phone.main!.x, 0)
  near('main top', phone.main!.y, 0)
  near('main right', phone.main!.right, PHONE.width)
  near('main bottom', phone.main!.bottom, PHONE.height)
  expect(phone.radius.main).toBe('0px')

  // The channels drawer: against the left edge, rounded towards the rail only (as before), square on its right.
  await page.getByRole('button', { name: 'Open channels' }).click()
  await expect(page.locator('.me-bar')).toBeVisible()
  await page.waitForTimeout(400)
  const drawer = await measure(page)
  report['phone-drawer'] = drawer
  await page.screenshot({ path: join(SHOTS, 'layout-frame-phone-drawer.png'), animations: 'disabled' })
  near('drawer sidebar bottom', drawer.sidebar!.bottom, PHONE.height)
  sameColor('drawer top-left (rail behind the rounded corner)', drawer.corners.sidebar!.topLeft, rgb(drawer.colors.rail))
  sameColor('drawer bottom-left (rail behind the rounded corner)', drawer.corners.sidebar!.bottomLeft, rgb(drawer.colors.rail))
  sameColor('drawer top-right (square)', drawer.corners.sidebar!.topRight, rgb(drawer.colors.sidebar))
  sameColor('drawer bottom-right (square)', drawer.corners.sidebar!.bottomRight, rgb(drawer.colors.sidebar))
  await context.close()
  await phoneServer.stop()
})
