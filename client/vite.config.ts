/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { defineConfig, type Connect, type Plugin } from 'vite'
import { CSP } from './src/csp.ts'

const csp = (): Plugin => ({
  name: 'iskra-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

// The live-captions model isn't in git or in the build: scripts/get-models.mjs puts it in .models/, and the dev and
// preview servers serve it at /models/ (as app.iskra.foo does after a deploy). Never copied into dist.
const MODELS = join(import.meta.dirname, '.models', 'models')
const serveModels: Connect.NextHandleFunction = (req, res, next) => {
  const file = normalize(join(MODELS, decodeURIComponent((req.url ?? '').split('?')[0])))
  if (!file.startsWith(MODELS) || !existsSync(file) || !statSync(file).isFile()) return next()
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Length', statSync(file).size)
  createReadStream(file).pipe(res)
}
const models = (): Plugin => ({
  name: 'iskra-models',
  configureServer: (server) => void server.middlewares.use('/models', serveModels),
  configurePreviewServer: (server) => void server.middlewares.use('/models', serveModels),
})

export default defineConfig({
  plugins: [react(), csp(), models()],
  // Only workers import these: bundle them up front, or the dev server reloads the page when it finds them.
  optimizeDeps: { include: ['onnxruntime-web/wasm', '@mediapipe/tasks-vision'] },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/i18n/testSetup.ts'],
  },
})
