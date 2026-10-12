// Desktop app start: launch to the first screen being usable, with a fresh profile and again with the same one.
// Needs desktop/ built (npm run build there) and client/dist. No server: nothing listens.
//   npx playwright test -c perf/perf.config.ts desktop-start
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const EXE = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

test('desktop start', async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const launch = (userData: string) => electron.launch({ executablePath: EXE, args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'], cwd: DESKTOP, env: { ...env, ISKRA_E2E: '1' } })
  const cold: number[] = []
  const again: number[] = []
  const js: number[] = []
  for (let i = 0; i < 5; i++) {
    const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-perf-'))
    try {
      let t = Date.now()
      let app = await launch(userData)
      let page = await app.firstWindow()
      await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible({ timeout: 60_000 })
      cold.push(Date.now() - t)
      js.push(await page.evaluate(() => Math.round(performance.getEntriesByType('resource').filter((e) => /\.js($|\?)/.test(e.name))
        .reduce((a, e) => a + (e as PerformanceResourceTiming).decodedBodySize, 0) / 1024)))
      await app.close()
      t = Date.now()
      app = await launch(userData)
      page = await app.firstWindow()
      await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible({ timeout: 60_000 })
      again.push(Date.now() - t)
      await app.close()
    } finally {
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
  console.log(`\ndesktop start to first screen: fresh profile median ${median(cold)} ms (${cold.join(', ')}), same profile median ${median(again)} ms (${again.join(', ')}); JS by then ${js[0]} KB`)
})
