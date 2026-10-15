import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect, test, type Locator } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Picture Crew')
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

/** A real (decodable) PNG: two colour bands, so cropping and scaling have something to show. */
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

test('server icon and banner: the owner sets them, members see them live, invites show the icon', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // Overview → icon and banner, each through the cropper.
  const room = await openServerSettings(host, 'Overview')
  await room.getByTestId('server-icon-file').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png(400, 300, [230, 90, 40], [40, 120, 220]) })
  await host.getByRole('button', { name: 'Use it' }).click()
  await expect(room.getByText('Icon updated')).toBeVisible()
  await room.getByTestId('server-banner-file').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: png(1200, 400, [30, 160, 90], [120, 40, 200]) })
  await host.getByRole('button', { name: 'Use it' }).click()
  await expect(room.getByText('Banner updated')).toBeVisible()
  await room.screenshot({ path: join(SHOTS, 'server-icon-banner-settings.png') })
  await host.keyboard.press('Escape')

  // The rail, the header and the banner show them at once; the name is the alt text.
  const railIcon = host.locator('.server-rail .server-icon img.server-picture')
  await expect(railIcon).toHaveAttribute('alt', 'Picture Crew')
  await expect.poll(() => loaded(railIcon)).toBe(true)
  const banner = host.getByTestId('server-banner').locator('img')
  await expect(banner).toHaveAttribute('alt', 'Picture Crew')
  await expect.poll(() => loaded(banner)).toBe(true)
  await expect(host.locator('.server-header-icon img')).toBeVisible()

  // A friend opening the invite sees the icon before joining (fetched from the server's public GET /icon).
  const link = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await friend.goto(link)
  await expect(friend.getByText("You've been invited")).toBeVisible()
  await agreeToTerms(friend)
  const inviteIcon = friend.getByTestId('invite-icon')
  await expect(inviteIcon).toHaveAttribute('alt', 'Picture Crew')
  await expect.poll(() => loaded(inviteIcon)).toBe(true)
  await friend.screenshot({ path: join(SHOTS, 'server-icon-invite.png') })

  // Joined, they see both too.
  await joinVia(friend, link, 'Friend')
  const friendIcon = friend.locator('.server-rail .server-icon img.server-picture')
  await expect.poll(() => loaded(friendIcon)).toBe(true)
  await expect.poll(() => loaded(friend.getByTestId('server-banner').locator('img'))).toBe(true)
  await friend.screenshot({ path: join(SHOTS, 'server-icon-banner-member.png') })

  // Members can't change them: no Overview for them, and the server would refuse anyway.
  await expect(friend.locator('.server-header-button')).toBeVisible()

  // The owner removes the banner: it goes for the friend live, the icon stays.
  const settings = await openServerSettings(host, 'Overview')
  await settings.getByTestId('server-banner-remove').click()
  await expect(settings.getByText('Banner removed')).toBeVisible()
  await expect(friend.getByTestId('server-banner')).toHaveCount(0)
  await expect(friendIcon).toBeVisible()

  // The served icon carries no metadata.
  const src = await friendIcon.getAttribute('src')
  expect(src).toBeTruthy()
  const text = await friend.evaluate(async (url) => new TextDecoder('latin1').decode(await (await fetch(url)).arrayBuffer()), src!)
  expect(text.length).toBeGreaterThan(0)
  expect(text).not.toContain('taken at home')
})
