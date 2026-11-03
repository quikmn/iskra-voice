// Settings → Appearance: pick a theme, pick a font, and "Use the theme's font when it names one". The fonts ship
// with the app (no request leaves for a font). Then every built-in theme on a chat screen, on a desktop and on a
// phone, for looking at: e2e/screenshots/theme-<id>-desktop.png, theme-<id>-phone.png, theme-<id>-settings.png.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { BUILT_IN_THEMES } from '../src/theme/themes'
import { BODY_FONTS } from '../src/theme/fonts'
import { createInviteLink, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Palette Club')
})
test.afterAll(async () => server?.stop())

const DESKTOP = { width: 1280, height: 720 }
const PHONE = { width: 390, height: 844 }
const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' })
/** The name of a built-in theme's card. */
const cardName = (id: string, name: string) => (id === 'iskra' ? `${name} (default)` : name)

/** A few messages that show text, muted text, links, code and a mention. */
async function chatter(host: Page, friend: Page) {
  await send(friend, 'Hey @Host, the new themes are in. Pick one in My settings → Appearance.')
  await send(host, 'Trying them all. Notes in https://iskra.foo/docs/ and a bit of `inline code`.')
  await send(friend, '```js\nconst theme = { accent: "#695bff", radius: 10 } // one ladder for every look\n```')
  await send(host, 'Fonts are their own setting now, so switching themes never changes the text.')
  await expect(host.locator('.message-text', { hasText: 'their own setting' })).toBeVisible()
}

test('appearance: themes, fonts and the theme font checkbox; every theme on a desktop and a phone', async ({ browser }) => {
  test.setTimeout(240_000)
  const hostContext = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce' })
  const host = await hostContext.newPage()
  const external: string[] = []
  host.on('request', (r) => {
    const url = new URL(r.url())
    if (/\.(woff2?|ttf|otf)$/.test(url.pathname) && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') external.push(r.url())
  })
  await joinVia(host, server.ownerLink(), 'Host')
  const phoneContext = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  const phone = await phoneContext.newPage()
  await joinVia(phone, await createInviteLink(host), 'Friend')
  await chatter(host, phone)

  // The default look: Iskra, Inter (bundled, so it really is Inter on every system).
  expect(await cssVar(host, '--accent')).toBe('#695bff')
  expect(await cssVar(host, '--font')).toBe(BODY_FONTS.inter)
  const loaded = (family: string) => host.evaluate(async (f) => {
    await document.fonts.load(`16px "${f}"`)
    return [...document.fonts].some((face) => face.family.replace(/"/g, '') === f && face.status === 'loaded')
  }, family)
  expect(await loaded('Inter')).toBe(true)
  expect(await loaded('JetBrains Mono')).toBe(true)

  await openSettings(host, 'Appearance')
  const room = dialog(host)
  const useThemeFont = room.getByRole('checkbox', { name: "Use the theme's font when it names one" })
  await expect(useThemeFont).toBeChecked()
  await expect(room.getByTestId('font-helper')).toHaveText("This theme doesn't name a font.")
  await expect(room.getByRole('radio', { name: /^Inter/ })).toHaveAttribute('aria-checked', 'true')
  await host.screenshot({ path: join(SHOTS, 'appearance-desktop.png') })

  // Switching between built-in themes never changes the font.
  await room.getByRole('radio', { name: 'Nord', exact: true }).click()
  await expect.poll(() => cssVar(host, '--accent')).toBe('#88c0d0')
  expect(await cssVar(host, '--font')).toBe(BODY_FONTS.inter)

  // The person's font: Rounded is the bundled Nunito.
  await room.getByRole('radio', { name: /^Rounded/ }).click()
  await expect.poll(() => cssVar(host, '--font')).toBe(BODY_FONTS.rounded)
  expect(await loaded('Nunito')).toBe(true)
  await room.getByLabel('Code font').selectOption('system')
  await expect.poll(() => cssVar(host, '--mono')).toContain('ui-monospace, Menlo')
  await room.getByRole('radio', { name: 'Synthwave 1984', exact: true }).click()
  expect(await cssVar(host, '--font')).toBe(BODY_FONTS.rounded)

  // A theme file that names a font: it applies while the box is ticked, and the page says so.
  await room.getByRole('button', { name: 'Write your own' }).click()
  await room.getByLabel('Theme JSON').fill(JSON.stringify({ meta: { name: 'Paper Serif' }, colors: { accent: '#e0a040', bgChat: '#1d1a16', bgSidebar: '#191612' }, fonts: { body: 'serif' } }))
  await room.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(() => cssVar(host, '--font')).toBe(BODY_FONTS.serif)
  await expect(room.getByRole('radio', { name: /Paper Serif/ })).toContainText('Aa Serif')
  await expect(room.getByTestId('font-helper')).toHaveText('"Paper Serif" uses Serif, so that\'s what you see now.')
  await expect(room.getByRole('radio', { name: /^Serif/ })).toContainText('Theme')
  await expect(room.getByRole('radio', { name: /^Rounded/ })).toHaveAttribute('aria-checked', 'true')
  await room.locator('.font-settings').scrollIntoViewIfNeeded()
  await host.screenshot({ path: join(SHOTS, 'appearance-theme-font.png') })

  // Unticked: the person's choice wins.
  await useThemeFont.uncheck()
  await expect.poll(() => cssVar(host, '--font')).toBe(BODY_FONTS.rounded)
  await expect(room.getByTestId('font-helper')).toHaveCount(0)
  await useThemeFont.check()
  await expect.poll(() => cssVar(host, '--font')).toBe(BODY_FONTS.serif)
  // Picking a font while the theme's is in use means "this one": the box unticks.
  await room.getByRole('radio', { name: /^Monospace/ }).click()
  await expect.poll(() => cssVar(host, '--font')).toBe(BODY_FONTS.mono)
  await expect(useThemeFont).not.toBeChecked()

  // It's all kept on this device.
  await host.reload()
  await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()
  expect(await cssVar(host, '--font')).toBe(BODY_FONTS.mono)
  expect(await host.evaluate(() => JSON.parse(localStorage.getItem('iskra.font') ?? 'null'))).toEqual({ body: 'mono', mono: 'system', useThemeFont: false })
  // Back to the defaults for the pictures.
  await host.evaluate(() => localStorage.setItem('iskra.font', JSON.stringify({ body: 'inter', mono: 'jetbrains', useThemeFont: true })))

  // Every built-in theme: the chat on a desktop, the Appearance page, and the chat on a phone.
  for (const { id, theme } of BUILT_IN_THEMES) {
    await openSettings(host, 'Appearance')
    await dialog(host).getByRole('radio', { name: cardName(id, theme.meta.name), exact: true }).click()
    await expect.poll(() => cssVar(host, '--surface')).toBe(theme.colors.bgChat)
    await host.mouse.move(640, 300)
    await host.screenshot({ path: join(SHOTS, `theme-${id}-settings.png`) })
    await host.keyboard.press('Escape')
    await host.locator('.message', { hasText: 'their own setting' }).hover()
    await host.screenshot({ path: join(SHOTS, `theme-${id}-desktop.png`) })

    await phone.evaluate((choice) => localStorage.setItem('iskra.theme', choice), JSON.stringify({ id }))
    await phone.reload()
    await expect(phone.getByRole('heading', { name: 'general' })).toBeVisible()
    await expect.poll(() => cssVar(phone, '--surface')).toBe(theme.colors.bgChat)
    await expect(phone.locator('.message-text', { hasText: 'their own setting' })).toBeVisible()
    await phone.screenshot({ path: join(SHOTS, `theme-${id}-phone.png`) })
  }
  expect(external).toEqual([])
})
