// Google Play store graphics: phone screenshots (1080×1920, 9:16) of the key screens in English and Swedish, with demo
// content (storeShots.ts, shared with app-store.spec.ts), plus the feature graphic and the 512 px icon. Not part of the
// normal run:
//   cd server; dotnet build src/Iskra.Server
//   cd client; $env:PLAY_SHOTS=1; $env:ISKRA_E2E_PORT=5299; npx playwright test e2e/play-store.spec.ts
// Output (git-ignored): docs/store/play/screenshots/<en-US|sv-SE>/*.png and docs/store/play/graphics/*.png.
// See docs/store/play/app-content.md. Everyone in the screenshots is made up.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { hasLiveKit, startServer, type TestServer } from './helpers'
import { CONTENT, serverScreens, startScreen, takeShot, type Device, type Lang } from './storeShots'

test.skip(!process.env.PLAY_SHOTS, 'Play store screenshots: set PLAY_SHOTS=1')
test.use({ actionTimeout: 10_000 })

const PLAY = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/store/play')
const GRAPHICS = join(PLAY, 'graphics')

/** 360×640 CSS pixels at 3x: 1080×1920, Play's 9:16 phone size. */
const PHONE: Device = { platform: 'android', context: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } }
const FOLDER: Record<Lang, string> = { en: 'en-US', sv: 'sv-SE' }

for (const lang of ['en', 'sv'] as const) {
  test.describe(`Play screenshots (${lang})`, () => {
    const shot = (page: Parameters<typeof takeShot>[0], name: string) => takeShot(page, lang, join(PLAY, 'screenshots', FOLDER[lang], `${name}.png`))
    let server: TestServer
    test.beforeAll(async () => {
      server = await startServer(CONTENT[lang].server, hasLiveKit())
    })
    test.afterAll(async () => server?.stop())

    test(`phone screens in ${FOLDER[lang]}`, async ({ browser }) => {
      test.setTimeout(300_000)
      await serverScreens(browser, server, lang, PHONE, shot)
    })

    test(`start a server in ${FOLDER[lang]}`, async ({ browser }) => {
      await startScreen(browser, lang, PHONE, shot)
    })
  })
}

test('feature graphic and icon', async ({ browser }) => {
  mkdirSync(GRAPHICS, { recursive: true })
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 500 } })).newPage()
  for (const lang of ['en', 'sv'] as const) {
    await page.goto(`${pathToFileURL(join(PLAY, 'feature-graphic.html')).href}?lang=${lang}`)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: join(GRAPHICS, `feature-graphic-${lang}.png`) })
  }
  await page.setViewportSize({ width: 512, height: 512 })
  await page.goto(pathToFileURL(join(PLAY, 'icon.html')).href)
  await expect(page.locator('img')).toHaveJSProperty('complete', true)
  await page.screenshot({ path: join(GRAPHICS, 'icon-512.png') })
  await page.context().close()
})
