import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect, test, type Locator } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Avatar Crew')
})
test.afterAll(async () => server?.stop())

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const b of data) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real (decodable) PNG: two colour bands, so cropping has something to show. */
function png(width: number, height: number, a: [number, number, number], b: [number, number, number]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) row.set(x < width / 2 ? a : b, 1 + x * 3)
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0taken at home', 'latin1')), // metadata the server takes out
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const loaded = (img: Locator) => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)

test('a picture per server: set next to the nickname, shown to everyone here, the profile picture untouched', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const sam = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(sam, await createInviteLink(host), 'Sam')

  // Sam, on a phone: server menu → Server nickname… → a picture for this server, through the cropper.
  await sam.getByRole('button', { name: 'Open channels' }).click()
  await sam.locator('.server-header-button').click()
  await sam.getByRole('menuitem', { name: 'Server nickname…' }).click()
  const dialog = sam.getByRole('dialog', { name: 'Server nickname on Avatar Crew' })
  const field = dialog.getByTestId('server-avatar')
  await expect(field).toContainText('Shown instead of your profile picture on Avatar Crew only')
  await field.getByTestId('server-avatar-file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png(300, 200, [230, 90, 40], [40, 120, 220]) })
  await sam.getByRole('button', { name: 'Use it' }).click()
  await expect(field.getByRole('status')).toHaveText('Picture updated.')
  await expect(field.locator('img.avatar-image')).toBeVisible()
  await sam.screenshot({ path: join(SHOTS, 'server-avatar-phone.png') })
  await sam.keyboard.press('Escape')

  // The host sees it in the member list at once (and it loads).
  const inList = host.locator('.member-list .member', { hasText: 'Sam' }).locator('img.avatar-image')
  await expect(inList).toBeVisible()
  await expect.poll(() => loaded(inList)).toBe(true)
  await host.screenshot({ path: join(SHOTS, 'server-avatar-member-list.png') })

  // Sam's profile picture (My settings → Profile) is still none: the picture is this server's only.
  await openSettings(sam, 'Profile')
  const profile = sam.getByRole('dialog', { name: 'Settings' })
  await expect(profile.getByRole('button', { name: 'Upload picture' })).toBeVisible()
  await expect(profile.locator('.avatar-row img.avatar-image')).toHaveCount(0)
  await sam.keyboard.press('Escape')

  // Remove it: initials again, for everyone.
  await sam.locator('.server-header-button').click()
  await sam.getByRole('menuitem', { name: 'Server nickname…' }).click()
  await dialog.getByTestId('server-avatar').getByRole('button', { name: 'Remove' }).click()
  await expect(dialog.getByTestId('server-avatar').getByRole('status')).toHaveText('Picture removed: the profile picture shows again.')
  await expect(host.locator('.member-list .member', { hasText: 'Sam' }).locator('img.avatar-image')).toHaveCount(0)
})
