/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { shortCommit } from './src/commit.ts'
import { CSP } from './src/csp.ts'
import { activities } from './activities.vite.ts'
import { RELEASE_VERSION } from './src/links.ts'
import { releaseNotesFor } from './src/releaseNotes.ts'

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

// This version's "What's new" lines for the card after an update (src/state/whatsNew.ts); null without notes.
const WHATS_NEW = releaseNotesFor(RELEASE_VERSION, (file) => {
  try {
    return readFileSync(new URL(`../docs/releases/${file}`, import.meta.url), 'utf8')
  } catch {
    return null
  }
})

export default defineConfig({
  plugins: [react(), csp(), activities()],
  define: { __ISKRA_COMMIT__: JSON.stringify(COMMIT), __ISKRA_WHATS_NEW__: JSON.stringify(WHATS_NEW) },
  // Only workers import these: bundle them up front, or the dev server reloads the page when it finds them.
  optimizeDeps: { include: ['onnxruntime-web/wasm', '@mediapipe/tasks-vision', 'eld/extrasmall'] },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/core/testSetup.ts', 'src/i18n/testSetup.ts'],
  },
})
