// App Store screenshots: iPhone 6.9" (1320×2868) and iPad 13" (2064×2752) PNGs of the key screens in English and
// Swedish, with the same demo content as the Play screenshots (storeShots.ts). Not part of the normal run:
//   cd server; dotnet build src/Iskra.Server
//   cd client; $env:APPSTORE_SHOTS=1; $env:ISKRA_E2E_PORT=5299; npx playwright test e2e/app-store.spec.ts
// Output: docs/store/appstore/screenshots/<en-US|sv>/<iphone|ipad>/*.png, which scripts/appstore.mjs uploads in phase B
// (docs/store/appstore/README.md). Everyone in the screenshots is made up.
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@playwright/test'
import { hasLiveKit, startServer, type TestServer } from './helpers'
import { CONTENT, serverScreens, startScreen, takeShot, type Device, type Lang } from './storeShots'

test.skip(!process.env.APPSTORE_SHOTS, 'App Store screenshots: set APPSTORE_SHOTS=1')
test.use({ actionTimeout: 10_000 })

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/store/appstore/screenshots')
/** App Store Connect's locale codes (the folders scripts/appstore.mjs reads). */
const FOLDER: Record<Lang, string> = { en: 'en-US', sv: 'sv' }

/** 440×956 CSS pixels at 3x = 1320×2868 (iPhone 6.9"); 1032×1376 at 2x = 2064×2752 (iPad 13"). */
const DEVICES: Record<'iphone' | 'ipad', Device> = {
  iphone: { platform: 'ios', context: { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  ipad: { platform: 'ios', context: { viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
}

for (const lang of ['en', 'sv'] as const) {
  for (const [kind, device] of Object.entries(DEVICES)) {
    test.describe(`App Store screenshots (${lang}, ${kind})`, () => {
      const shot = (page: Parameters<typeof takeShot>[0], name: string) => takeShot(page, lang, join(SHOTS, FOLDER[lang], kind, `${name}.png`))
      let server: TestServer
      test.beforeAll(async () => {
        server = await startServer(CONTENT[lang].server, hasLiveKit())
      })
      test.afterAll(async () => server?.stop())

      test(`${kind} screens in ${FOLDER[lang]}`, async ({ browser }) => {
        test.setTimeout(300_000)
        await serverScreens(browser, server, lang, device, shot)
      })

      test(`${kind}: start a server in ${FOLDER[lang]}`, async ({ browser }) => {
        await startScreen(browser, lang, device, shot)
      })
    })
  }
}
