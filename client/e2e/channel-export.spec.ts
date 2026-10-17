// Channel export: an admin exports #general (a reply, a reaction, an image and a thread) from Server settings, downloads
// the zip, and the exported page opens offline from disk with everything in it and nothing loaded from anywhere.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Export Night')
})
test.afterAll(async () => server?.stop())

// A 3×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')

/** The files in a zip, read through its central directory (enough for the server's exports). */
function unzip(zip: Buffer): Record<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const files: Record<string, Buffer> = {}
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10)
    const size = zip.readUInt32LE(at + 20)
    const nameLength = zip.readUInt16LE(at + 28)
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    const local = zip.readUInt32LE(at + 42)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + size)
    files[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data)
    at += 46 + skip
  }
  return files
}

test('an admin exports a channel and reads it offline', async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const host = await ownerContext.newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // An image, a reply with a reaction, and a thread.
  await host.locator('input[type=file]').setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: PNG })
  await expect(host.locator('.pending-upload .muted')).toHaveText(`${PNG.length} B`, { timeout: 10_000 })
  await send(host, 'look at this <b>cat</b>')
  await send(host, 'banana bread this weekend?')
  const image = friend.locator('.message', { hasText: 'look at this' }).first()
  await image.hover()
  await image.getByRole('button', { name: 'Reply' }).click()
  await send(friend, 'nice!')
  await image.hover()
  await image.getByRole('button', { name: 'Add reaction' }).click()
  await friend.locator('.reaction-picker').getByRole('menuitem', { name: '🔥' }).click()
  await expect(host.locator('.message', { hasText: 'look at this' }).first().locator('.reaction')).toContainText('🔥 1')
  const bread = friend.locator('.message', { hasText: 'banana bread' })
  await bread.hover()
  await bread.getByRole('button', { name: 'Start a thread' }).click()
  await friend.getByLabel('Thread name').fill('Baking plans')
  await friend.getByRole('button', { name: 'Create thread' }).click()
  const reply = friend.locator('.thread-panel').getByPlaceholder('Reply in the thread')
  await reply.fill('I will bring the flour')
  await reply.press('Enter')
  await expect(host.locator('.thread-summary', { hasText: 'Baking plans' })).toContainText('1 reply')

  // Members can't export.
  await friend.locator('.server-header-button').click()
  await expect(friend.getByRole('menuitem', { name: 'Server settings', exact: true })).toHaveCount(0)
  await friend.keyboard.press('Escape')

  let zip: Buffer | null = null
  await ownerContext.route('**/channel-export/*', async (route) => {
    const response = await route.fetch()
    zip = await response.body()
    await route.fulfill({ response })
  })

  const room = await openServerSettings(host, 'Export channels')
  const section = room.getByTestId('export-section')
  await expect(section.getByRole('button', { name: 'Export 1 channel' })).toBeDisabled()
  await section.getByRole('checkbox', { name: /general/ }).check()
  await expect(section.getByRole('checkbox', { name: 'Include files and images' })).toBeChecked()
  await section.getByRole('button', { name: 'Export 1 channel' }).click()
  const job = section.getByTestId('export-job').first()
  await expect(job).toContainText('#general')
  await expect(job.getByText(/^Ready: /)).toBeVisible({ timeout: 20_000 })
  await expect(job).toContainText('The link works until')
  await host.screenshot({ path: join(SHOTS, 'channel-export.png') })
  await job.getByRole('button', { name: 'Download' }).click()
  await expect.poll(() => zip !== null, { timeout: 15_000 }).toBe(true)
  // Phone width: nothing runs off the side.
  await host.setViewportSize({ width: 390, height: 844 })
  await expect(section.getByTestId('export-job').first()).toBeVisible()
  expect(await section.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await host.screenshot({ path: join(SHOTS, 'channel-export-phone.png') })

  const files = unzip(zip!)
  const general = Object.keys(files).find((k) => k.endsWith('/channel.html'))!
  expect(general).toMatch(/^\d+-general\/channel\.html$/)
  const folder = dirname(general)
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['README.txt', `${folder}/channel.json`, `${folder}/attachments/1-cat.png`]))
  const json = JSON.parse(files[`${folder}/channel.json`].toString('utf8'))
  expect(json.format).toBe('iskra-channel-export')
  expect(json.threads[0].messages[0].text).toBe('I will bring the flour')

  // Open it from disk, offline: everything shows, nothing is fetched, the CSP lets the page's own style and images in.
  const dir = mkdtempSync(join(tmpdir(), 'iskra-export-'))
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true })
    writeFileSync(join(dir, name), data)
  }
  const offline = await browser.newContext({ offline: true })
  const page = await offline.newPage()
  const requests: string[] = []
  const problems: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
  await page.goto(pathToFileURL(join(dir, general)).href)
  await expect(page.locator('h1')).toHaveText('#general')
  await expect(page.locator('header .server')).toHaveText('Export Night')
  const cat = page.locator('.msg', { hasText: 'look at this' }).first()
  await expect(cat.locator('.author').first()).toHaveText('Host')
  await expect(cat.locator('.text').first()).toHaveText('look at this <b>cat</b>') // as text, never as markup
  await expect.poll(() => cat.locator('img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(3)
  await expect(cat.locator('.reactions').first()).toHaveText('🔥 1')
  const nice = page.locator('.msg', { hasText: 'nice!' })
  await expect(nice.locator('.reply')).toContainText('Host')
  await expect(nice.locator('.reply')).toContainText('look at this')
  const thread = page.locator('section.thread', { hasText: 'Baking plans' })
  await expect(thread).toContainText('I will bring the flour')
  await expect(page.locator('body')).toHaveCSS('background-color', /rgb/) // the stylesheet applied
  expect(await page.locator('.avatar').first().evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%')
  expect(await page.locator('script').count()).toBe(0)
  expect(requests.every((url) => url.startsWith('file:'))).toBe(true)
  expect(problems.filter((p) => /Content Security Policy/i.test(p))).toEqual([])
  await page.screenshot({ path: join(SHOTS, 'channel-export-page.png'), fullPage: true })

  // At phone width.
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(SHOTS, 'channel-export-page-phone.png') })
  await offline.close()
})
