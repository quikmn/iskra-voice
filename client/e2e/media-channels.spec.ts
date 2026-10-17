import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Media Crew')
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

/** A decodable PNG with a diagonal gradient between two colours. */
function png(width: number, height: number, a: [number, number, number], b: [number, number, number]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      const f = (x / width + y / height) / 2
      row.set(a.map((v, i) => Math.round(v + (b[i] - v) * f)), 1 + x * 3)
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const picture = (name: string, width: number, height: number, a: [number, number, number], b: [number, number, number]) =>
  ({ name, mimeType: 'image/png', buffer: png(width, height, a, b) })

test('a media channel: post pictures, browse the grid, open the viewer, comment and filter by tag', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // The owner makes a media channel; the dialog says it can't be encrypted.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Media' }).click()
  await expect(create.getByText('gallery: posts of pictures and videos')).toBeVisible()
  await expect(create.getByTestId('e2ee-toggle')).toBeDisabled()
  await create.getByPlaceholder('game-night').fill('art')
  await host.screenshot({ path: join(SHOTS, 'media-create.png') })
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'art' })).toBeVisible()
  await expect(host.getByText('Nothing here yet')).toBeVisible()

  // Two tags.
  await host.getByRole('button', { name: 'Edit tags' }).click()
  const tagsDialog = host.getByRole('dialog', { name: 'Forum tags' })
  await tagsDialog.getByRole('button', { name: 'Add a tag' }).click()
  await tagsDialog.getByLabel('Tag name').last().fill('Sketch')
  await tagsDialog.getByRole('button', { name: 'Add a tag' }).click()
  await tagsDialog.getByLabel('Tag name').last().fill('Paint')
  await tagsDialog.getByLabel('Emoji (optional)').last().fill('🎨')
  await tagsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(host.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: 'Paint' })).toBeVisible()

  // The friend posts three pictures with a caption and a tag; the viewer opens on the first.
  await friend.locator('.channel-list .channel', { hasText: 'art' }).click()
  await friend.locator('.forum-toolbar').getByRole('button', { name: 'Post' }).click()
  const newPost = friend.getByRole('dialog', { name: 'New post' })
  await newPost.getByTestId('media-file-input').setInputFiles([
    picture('dawn.png', 240, 320, [250, 160, 90], [120, 60, 160]),
    picture('noon.png', 320, 200, [90, 180, 250], [240, 240, 200]),
    picture('dusk.png', 260, 260, [40, 40, 90], [230, 110, 80]),
  ])
  await expect(newPost.locator('.media-picked li')).toHaveCount(3)
  await newPost.getByPlaceholder('Say something about it').fill('Three studies of the same hill')
  await newPost.getByRole('button', { name: 'Sketch' }).click()
  await friend.screenshot({ path: join(SHOTS, 'media-new-post.png') })
  await newPost.getByTestId('media-post-submit').click()
  const friendViewer = friend.getByTestId('media-viewer')
  await expect(friendViewer).toBeVisible()
  await expect(friendViewer.locator('.media-viewer-count')).toHaveText('1 of 3')
  await friendViewer.getByRole('button', { name: 'Show 3 of 3' }).click()
  await expect(friendViewer.locator('.media-viewer-count')).toHaveText('3 of 3')
  await friend.keyboard.press('Escape')
  await expect(friendViewer).toHaveCount(0)

  // The host posts one titled picture with the other tag; both show in the grid.
  await host.locator('.forum-toolbar').getByRole('button', { name: 'Post' }).click()
  const hostPost = host.getByRole('dialog', { name: 'New post' })
  await hostPost.getByTestId('media-file-input').setInputFiles([picture('sunset.png', 300, 400, [255, 120, 60], [60, 20, 90])])
  await hostPost.getByPlaceholder('Give it a name').fill('Sunset')
  await hostPost.getByRole('button', { name: 'Paint' }).click()
  await hostPost.getByTestId('media-post-submit').click()
  const hostViewer = host.getByTestId('media-viewer')
  await expect(hostViewer.locator('.media-viewer-title')).toHaveText('Sunset')
  await host.keyboard.press('Escape')
  const tiles = host.getByTestId('media-tile')
  await expect(tiles).toHaveCount(2)

  // The grid works from the keyboard: arrows move between tiles, Enter opens one.
  await tiles.first().focus()
  await host.keyboard.press('ArrowRight')
  await expect(tiles.nth(1)).toBeFocused()
  await host.keyboard.press('Enter')
  await expect(hostViewer.locator('.media-viewer-title')).toHaveText('Three studies of the same hill')
  await host.keyboard.press('ArrowLeft')
  await expect(hostViewer.locator('.media-viewer-title')).toHaveText('Sunset')
  await hostViewer.getByRole('button', { name: 'Next post' }).click()
  await expect(hostViewer.locator('.media-viewer-title')).toHaveText('Three studies of the same hill')
  await expect(hostViewer.getByRole('button', { name: 'Next post' })).toBeDisabled()

  // Comments are the post's thread, beside the picture.
  const comment = hostViewer.locator('.thread-panel').getByPlaceholder('Reply to the post')
  await comment.fill('Love the colours in the last one')
  await comment.press('Enter')
  await expect(hostViewer.locator('.thread-panel .message', { hasText: 'Love the colours' })).toBeVisible()
  // Arrow keys while typing stay in the field.
  await comment.fill('abc')
  await comment.press('ArrowLeft')
  await expect(hostViewer.locator('.media-viewer-title')).toHaveText('Three studies of the same hill')
  await comment.fill('')
  await host.screenshot({ path: join(SHOTS, 'media-viewer.png') })
  await host.keyboard.press('Escape') // leaves the composer
  if (await hostViewer.count()) await host.keyboard.press('Escape')
  await expect(hostViewer).toHaveCount(0)
  await expect(tiles.nth(1)).toHaveAttribute('aria-label', /1 comment/)

  // The friend sees the comment count; tag filters narrow the grid.
  const friendTiles = friend.getByTestId('media-tile')
  await expect(friendTiles.filter({ has: friend.locator('.media-title', { hasText: 'Three studies' }) }).locator('.media-count').last()).toHaveText('1')
  const filters = host.getByRole('group', { name: 'Filter by tag' })
  await filters.getByRole('button', { name: 'Paint' }).click()
  await expect(tiles).toHaveCount(1)
  await expect(tiles.first()).toHaveAttribute('aria-label', /Sunset/)
  await filters.getByRole('button', { name: 'All' }).click()
  await expect(tiles).toHaveCount(2)
  await host.getByRole('searchbox', { name: 'Search posts' }).fill('studies')
  await expect(tiles).toHaveCount(1)
  await host.getByRole('searchbox', { name: 'Search posts' }).fill('')
  await expect(tiles).toHaveCount(2)
  await tiles.first().hover()
  await host.waitForTimeout(300) // the info fades in
  await host.screenshot({ path: join(SHOTS, 'media-grid.png') })

  // Phones: two columns that fit, and the viewer puts the comments below the picture.
  await friend.setViewportSize({ width: 390, height: 844 })
  await expect(friendTiles).toHaveCount(2)
  expect(await friend.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await friend.waitForTimeout(400) // the side panels slide away
  await friend.screenshot({ path: join(SHOTS, 'media-grid-mobile.png') })
  await friendTiles.first().click()
  const phoneViewer = friend.getByTestId('media-viewer')
  await expect(phoneViewer.locator('.thread-panel')).toBeVisible()
  const stage = await phoneViewer.locator('.media-viewer-main').boundingBox()
  const comments = await phoneViewer.locator('.thread-panel').boundingBox()
  expect(comments!.y).toBeGreaterThanOrEqual(stage!.y + stage!.height - 1)
  await friend.waitForTimeout(300)
  await friend.screenshot({ path: join(SHOTS, 'media-viewer-mobile.png') })
  await phoneViewer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(phoneViewer).toHaveCount(0)
})
