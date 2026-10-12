/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { CSP } from './src/csp.ts'

const csp = (): Plugin => ({
  name: 'iskra-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  plugins: [react(), csp()],
  // Only workers import these: bundle them up front, or the dev server reloads the page when it finds them.
  optimizeDeps: { include: ['onnxruntime-web/wasm', '@mediapipe/tasks-vision'] },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/i18n/testSetup.ts'],
  },
})
