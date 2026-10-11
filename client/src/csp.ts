/**
 * Strict Content-Security-Policy for production builds (dev needs inline scripts for hot reload).
 * Injected by vite.config.ts; the desktop app's Electron check (desktop/src/embeds.check.ts) loads embeds under it too.
 * The phone app (mobile/) runs the same build from capacitor://localhost, where 'self' is that origin; its native
 * bridge script is injected by the web view, not loaded by the page, so it needs nothing here.
 * Servers are arbitrary hosts, so connections are allowed to any http(s)/ws(s) origin; scripts are not.
 */
export const CSP = [
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
