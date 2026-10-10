// Runs the TypeScript client against the real .NET server. `npm run test:interop` builds the server first.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['interop/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
