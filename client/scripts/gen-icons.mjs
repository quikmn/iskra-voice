// Renders the app icons (PWA manifest, iOS home screen) from public/favicon.svg with Playwright's Chromium.
// Run from client/: node scripts/gen-icons.mjs
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const bolt = readFileSync('public/favicon.svg', 'utf8')
const BG = '#0b0b14'

// [file, size, bolt size as a fraction of the icon, corner radius as a fraction (0 = full bleed)]
const icons = [
  ['public/icons/icon-192.png', 192, 0.72, 0.22],
  ['public/icons/icon-512.png', 512, 0.72, 0.22],
  ['public/icons/maskable-512.png', 512, 0.56, 0], // the bolt stays inside the 80% safe zone
  ['public/icons/apple-touch-icon.png', 180, 0.66, 0], // iOS rounds the corners itself
]

const browser = await chromium.launch()
for (const [file, size, scale, radius] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  const inner = Math.round(size * scale)
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:${BG};border-radius:${radius * 100}%;
      background-image:radial-gradient(circle at 50% 40%, rgba(124,111,255,0.28), transparent 65%)">
      <div style="width:${inner}px;height:${inner}px">${bolt.replace('<svg ', `<svg style="width:100%;height:100%" `)}</div>
    </div></body></html>`)
  await page.screenshot({ path: file, omitBackground: true })
  await page.close()
  console.log(file)
}

// Android's small status-bar icon for notifications: a white silhouette on transparent.
const badge = await browser.newPage({ viewport: { width: 96, height: 96 } })
await badge.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
  ${bolt.replace('<svg ', '<svg style="width:96px;height:96px;display:block" ').replace('url(#bolt)', '#fff')}</body></html>`)
await badge.screenshot({ path: 'public/icons/badge-96.png', omitBackground: true })
console.log('public/icons/badge-96.png')
await browser.close()
