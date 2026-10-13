// Performance runs (not part of test:e2e): the BUILT app (vite preview of dist/, or ISKRA_PERF_DIST) against real servers.
// npm run build; npx playwright test -c perf/perf.config.ts perf/<spec>   (ISKRA_E2E_PORT picks the app port)
import { defineConfig, devices } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_PORT } from '../playwright.config'

const client = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.env.ISKRA_PERF_DIST ?? resolve(client, 'dist')

export default defineConfig({
  testDir: '.',
  timeout: 20 * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${APP_PORT}`, locale: 'en-US' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone', 'camera'],
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info', '--js-flags=--expose-gc'] },
      },
    },
  ],
  webServer: {
    command: `npx vite preview --port ${APP_PORT} --strictPort --host localhost --outDir "${outDir}"`,
    url: `http://localhost:${APP_PORT}`,
    cwd: client,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
