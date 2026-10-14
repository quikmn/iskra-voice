/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { shortCommit } from './src/commit.ts'
import { CSP } from './src/csp.ts'

const csp = (): Plugin => ({
  name: 'iskra-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

// The commit shown in My settings → About & legal (src/buildInfo.ts).
const COMMIT = shortCommit(process.env, () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
})

export default defineConfig({
  plugins: [react(), csp()],
  define: { __ISKRA_COMMIT__: JSON.stringify(COMMIT) },
  // Only workers import these: bundle them up front, or the dev server reloads the page when it finds them.
  optimizeDeps: { include: ['onnxruntime-web/wasm', '@mediapipe/tasks-vision'] },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/i18n/testSetup.ts'],
  },
})
