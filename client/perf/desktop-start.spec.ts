// Desktop app start: launch to the first screen being usable, each time with a fresh profile.
// Needs desktop/ built (npm run build there) and client/dist. No server: nothing listens.
//   npx playwright test -c perf/perf.config.ts desktop-start
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { appWindow } from '../e2e/helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const EXE = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

test('desktop start', async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const launch = (userData: string) => electron.launch({ executablePath: EXE, args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'], cwd: DESKTOP, env: { ...env, ISKRA_E2E: '1' } })
  const cold: number[] = []
  for (let i = 0; i < 3; i++) {
    const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-perf-'))
    try {
      const t = Date.now()
      const app = await launch(userData)
      const page = await appWindow(app)
      await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible({ timeout: 60_000 })
      cold.push(Date.now() - t)
      app.process().kill()
      await new Promise((r) => setTimeout(r, 1500))
    } finally {
      try { rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* Electron still closing */ }
    }
  }
  console.log(`\ndesktop start to first screen: fresh profile median ${median(cold)} ms (${cold.join(', ')})`)
})
