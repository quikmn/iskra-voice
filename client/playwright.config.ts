// End-to-end: real browsers, the real web app (Vite dev server) and the real .NET server.
// Run with `npm run test:e2e` (builds the server first).
import { defineConfig, devices } from '@playwright/test'

export const APP_PORT = Number(process.env.ISKRA_E2E_PORT) || 5199

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  // On CI a failed test runs once more: passing then marks it flaky (listed in the job summary and the #ci message by
  // scripts/e2e-flaky.mjs); failing twice stays red. Never locally, so a flake shows up where it's fixed.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  // English (US) whatever the machine's language: the specs match the English text.
  use: { baseURL: `http://localhost:${APP_PORT}`, trace: 'retain-on-failure', locale: 'en-US' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen'] },
      },
    },
  ],
  webServer: {
    command: `npx vite --port ${APP_PORT} --strictPort`,
    url: `http://localhost:${APP_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
