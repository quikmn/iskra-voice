import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Files Test')
})
test.afterAll(async () => server?.stop())

// A 3×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')

test('share an image, reply to it and react', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // Attach an image with a caption.
  await host.locator('input[type=file]').setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: PNG })
  await expect(host.locator('.pending-upload .muted')).toHaveText(`${PNG.length} B`, { timeout: 10_000 })
  await send(host, 'look at this 👀')

  // The friend sees the image, actually loaded from the server.
  const image = friend.locator('.attachment-image img')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(3)

  // Reply to it.
  const imageMessage = friend.locator('.message', { hasText: 'look at this' }).first()
  await imageMessage.hover()
  await imageMessage.getByRole('button', { name: 'Reply' }).click()
  await expect(friend.locator('.reply-bar')).toContainText('Replying to Host')
  await send(friend, 'nice!')
  await expect(host.locator('.reply-line', { hasText: 'look at this' })).toBeVisible()

  // React to it.
  await imageMessage.hover()
  await imageMessage.getByRole('button', { name: 'Add reaction' }).click()
  await friend.locator('.reaction-picker').getByRole('menuitem', { name: '🔥' }).click()
  await expect(host.locator('.message', { hasText: 'look at this' }).first().locator('.reaction')).toContainText('🔥 1')

  // Text files show a preview with a download link; other files are download cards.
  await host.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect(host.locator('.pending-upload .muted')).toHaveText('5 B')
  await host.getByPlaceholder('Message #general').press('Enter')
  await expect(friend.locator('.text-file', { hasText: 'notes.txt' }).locator('.text-file-body')).toHaveText('hello')
  await host.locator('input[type=file]').setInputFiles({ name: 'data.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 3]) })
  await expect(host.locator('.pending-upload .muted')).toHaveText('4 B')
  await host.getByPlaceholder('Message #general').press('Enter')
  await expect(friend.locator('a.attachment-file', { hasText: 'data.bin' })).toBeVisible()

  await host.screenshot({ path: join(SHOTS, 'files.png') })
})
