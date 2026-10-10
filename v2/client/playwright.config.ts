// End-to-end: real browsers, the real web app (Vite dev server) and the real .NET server.
// Run with `npm run test:e2e` (builds the server first).
import { defineConfig, devices } from '@playwright/test'

export const APP_PORT = 5199

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${APP_PORT}`, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
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
