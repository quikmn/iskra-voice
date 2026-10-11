/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Strict Content-Security-Policy for production builds (dev needs inline scripts for hot reload).
 * Servers are arbitrary hosts, so connections are allowed to any http(s)/ws(s) origin; scripts are not.
 */
const CSP = [
  "default-src 'self'",
  // No third-party scripts: YouTube (watch parties) runs in its own sandboxed frame, driven over postMessage.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:", // attachments come from each server's own address
  "media-src 'self' blob: mediastream: http: https:",
  "connect-src 'self' ws: wss: http: https:",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  // Profile pages come from each server's own address (any http(s) origin, each in a locked-down wrapper); watch parties embed youtube-nocookie.com.
  "frame-src 'self' http: https: https://www.youtube-nocookie.com",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const csp = (): Plugin => ({
  name: 'iskra-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  plugins: [react(), csp()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
