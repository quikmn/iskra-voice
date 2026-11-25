// Photos channels: two members share one. Photos and a video are added (their hidden data is removed on the way),
// seen live, opened in the viewer, captioned, reacted to and commented on; albums, moving, the zip download, the
// filter by person, the storage limit and deleting many at once. An end-to-end encrypted photos channel keeps only
// ciphertext on the server. Phone layout and an accessibility check.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'photos')
const fixture = (name: string) => join(FIXTURES, name)
/** What the fixtures carry that must never reach the server: the place, the phone, its owner and serial number. */
const SECRETS = ['SecretCam', 'SecretPhone', 'Secret Owner', 'SN-SECRET', 'SecretLens', 'secret comment', '59.3293', 'Secret title', 'SecretShot']

let server: TestServer
test.beforeEach(async () => {
  server = await startServer('Photo Albums')
})
test.afterEach(async () => server?.stop())

/** Every stored upload of the server's world, as bytes. */
function storedUploads(): Buffer[] {
  const root = join(server.world, 'uploads')
  const out: Buffer[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(readFileSync(path))
    }
  }
  walk(root)
  return out
}

/** The file names in a zip, from its directory. */
function zipNames(zip: Buffer): string[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThanOrEqual(0)
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const nameLength = zip.readUInt16LE(at + 28)
    names.push(zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'))
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
  }
  return names
}

async function createPhotosChannel(page: Page, name: string, encrypted = false) {
  await page.getByRole('button', { name: 'Create channel' }).first().click()
  const create = page.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Photos' }).click()
  await create.getByPlaceholder('game-night').fill(name)
  await expect(create).toContainText('Location and device details are removed')
  if (encrypted) await create.getByTestId('e2ee-toggle').check()
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

/** Picks files and confirms the dialog. `album`: the visible name of an album to put them in. */
async function addPhotos(page: Page, files: string[], options: { keepDate?: boolean; newAlbum?: string } = {}) {
  await page.getByTestId('photos-file-input').setInputFiles(files.map(fixture))
  const dialog = page.getByRole('dialog', { name: new RegExp(`^Add ${files.length} file`) })
  await expect(dialog.getByTestId('photos-privacy-note')).toContainText('removed')
  if (options.keepDate === false) await dialog.getByTestId('photos-keep-date').uncheck()
  if (options.newAlbum) {
    await dialog.getByTestId('photos-add-album').selectOption('new')
    await dialog.getByTestId('photos-add-album-name').fill(options.newAlbum)
  }
  await dialog.getByTestId('photos-add-confirm').click()
}

const tiles = (page: Page) => page.locator('.photo-tile')
const grid = (page: Page) => page.getByTestId('photo-grid')

test('a photos channel shared by two members: add, view, albums, zip, filter, limit, delete', async ({ browser }) => {
  test.setTimeout(180_000)
  const hostContext = await browser.newContext()
  const host = await hostContext.newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  const invite = await createInviteLink(host)
  await joinVia(friend, invite, 'Friend')

  await createPhotosChannel(host, 'holiday')
  await expect(host.getByTestId('photos-empty')).toContainText('No photos yet')
  await friend.locator('.channel-list .channel', { hasText: 'holiday' }).click()
  await expect(friend.getByTestId('photos-empty')).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'photos-empty.png') })

  // The host adds a phone photo, a screenshot, a wide picture and a phone video in one go.
  await addPhotos(host, ['gps.jpg', 'screenshot.png', 'wide.jpg', 'clip.mp4'])
  await expect(host.getByTestId('photos-uploads')).toBeVisible()
  await expect(grid(host)).toHaveAttribute('data-count', '4')
  await expect(host.getByTestId('photos-uploads-summary')).toHaveText('4 files added')
  await expect(grid(friend)).toHaveAttribute('data-count', '4')
  await expect(tiles(friend).locator('img').first()).toBeVisible()
  // Every thumbnail drew, and the video shows its length.
  await expect.poll(() => tiles(host).locator('img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length)).toBe(4)
  await expect(host.locator('.photo-badge.video')).toContainText('0:02')
  // The photo taken in July 2024 sorts under that month; the ones without a date taken under their file's date.
  await expect(host.locator('.photo-month').last()).toHaveText('July 2024')
  await host.screenshot({ path: join(SHOTS, 'photos-grid.png') })

  // Nothing identifying is stored: not the place, the phone, its serial number, the owner or the comment.
  const stored = storedUploads()
  expect(stored.length).toBeGreaterThanOrEqual(8)
  for (const secret of SECRETS) expect(stored.some((bytes) => bytes.includes(secret)), secret).toBe(false)
  // The date taken is kept (the uploader left that on), and so is which way up the photo is.
  expect(stored.some((bytes) => bytes.includes('2024:07:14 18:30:05'))).toBe(true)

  // The viewer: who and when, arrows between photos, zoom, a caption, a reaction and a comment.
  await host.locator('.photo-month', { hasText: 'July 2024' }).scrollIntoViewIfNeeded()
  await tiles(host).last().locator('.photo-open').click()
  const viewer = host.getByTestId('photo-viewer')
  await expect(viewer.getByTestId('photo-viewer-uploader')).toHaveText('Host')
  await expect(viewer.getByTestId('photo-viewer-date')).toContainText('2024')
  const image = viewer.getByTestId('photo-viewer-image')
  await expect(image).toBeVisible()
  // The phone photo is stored on its side; it is shown upright (taller than wide).
  await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalHeight > (img as HTMLImageElement).naturalWidth)).toBe(true)
  await viewer.getByTestId('photo-zoom-in').click()
  await expect(image).toHaveAttribute('data-scale', '1.50')
  await host.keyboard.press('0')
  await expect(image).toHaveAttribute('data-scale', '1.00')
  await viewer.getByTestId('photo-caption-add').click()
  await viewer.getByTestId('photo-caption-input').fill('The lake at **sunset**')
  await viewer.getByTestId('photo-caption-save').click()
  await expect(viewer.getByTestId('photo-caption').locator('strong')).toHaveText('sunset')
  await viewer.getByTestId('photo-react').click()
  await host.getByRole('dialog', { name: 'Emoji picker' }).locator('.emoji-cell').first().click()
  await expect(viewer.locator('.photo-reactions .reaction')).toContainText('1')
  await viewer.getByTestId('photo-comments').click()
  const box = viewer.getByPlaceholder(/Reply/)
  await box.fill('Best evening of the trip')
  await box.press('Enter')
  await expect(viewer.locator('.thread-panel .message', { hasText: 'Best evening of the trip' })).toBeVisible()
  await expect(viewer.getByTestId('photo-comments')).toContainText('1 comment')
  await host.screenshot({ path: join(SHOTS, 'photos-viewer.png') })
  const a11y = await new AxeBuilder({ page: host }).include('[data-testid="photo-viewer"]').analyze()
  expect(a11y.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => v.id)).toEqual([])

  // A link to the photo opens it for the friend.
  await viewer.getByTestId('photo-more').click()
  await host.getByTestId('photo-copy-link').click()
  const link = await host.evaluate(() => navigator.clipboard.readText())
  expect(link).toMatch(/#\/open\/[\w-]{43}\/c\/\d+\/ph\/\d+$/)
  await expect(host.getByTestId('photo-copy-link')).toHaveCount(0)
  await viewer.getByTestId('photo-comments').click() // closes the comments
  await expect(viewer.locator('.thread-panel')).toHaveCount(0)
  // Left and right go through the photos; the video plays.
  await host.keyboard.press('ArrowLeft')
  await expect(viewer.getByTestId('photo-caption')).toHaveCount(0)
  await host.keyboard.press('ArrowRight')
  await expect(viewer.getByTestId('photo-caption')).toContainText('The lake at sunset')
  await host.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await host.locator('.photo-tile.video .photo-open').click()
  const video = host.getByTestId('photo-viewer-video')
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState >= 2 && (v as HTMLVideoElement).videoWidth)).toBe(160)
  await host.getByTestId('photo-viewer-close').click()

  await friend.evaluate((hash) => {
    location.hash = hash
  }, link.slice(link.indexOf('#')))
  const friendViewer = friend.getByTestId('photo-viewer')
  await expect(friendViewer.getByTestId('photo-caption')).toContainText('The lake at sunset')
  await expect(friendViewer.getByTestId('photo-comments')).toContainText('1 comment')
  // The friend didn't add it: no caption editing, no delete.
  await expect(friendViewer.getByTestId('photo-caption-edit')).toHaveCount(0)
  await friendViewer.getByTestId('photo-more').click()
  await expect(friend.getByTestId('photo-copy-link')).toBeVisible()
  await expect(friend.getByTestId('photo-delete')).toHaveCount(0)
  await friend.keyboard.press('Escape')
  await friend.getByTestId('photo-viewer-close').click()

  // Albums: the host makes one and moves two photos into it; the friend sees it with its count.
  await host.getByTestId('photos-tab-albums').click()
  await host.getByTestId('photos-new-album').click()
  await host.getByTestId('photos-album-name').fill('Summer 2026')
  await host.getByTestId('photos-album-save').click()
  await expect(host.getByTestId('photos-album-title')).toHaveText('Summer 2026')
  await expect(host.getByTestId('photos-empty')).toContainText('This album is empty')
  await host.getByTestId('photos-album-back').click()
  await host.getByTestId('photos-tab-photos').click()
  await host.getByTestId('photos-select').click()
  await tiles(host).nth(0).locator('.photo-open').click()
  await tiles(host).nth(3).locator('.photo-open').click()
  await expect(host.getByTestId('photos-selection')).toContainText('2 selected')
  await host.getByTestId('photos-move').click()
  await host.getByRole('dialog', { name: 'Move 2 photos' }).getByRole('button', { name: 'Summer 2026' }).click()
  await expect(host.getByTestId('photos-selection')).toHaveCount(0)
  await friend.getByTestId('photos-tab-albums').click()
  await expect(friend.getByTestId('photos-albums').getByRole('button', { name: 'Summer 2026, 2 photos' })).toBeVisible()
  await expect(friend.getByTestId('photos-album-none')).toContainText('2 photos')
  await friend.screenshot({ path: join(SHOTS, 'photos-albums.png') })
  await friend.getByTestId('photos-albums').getByRole('button', { name: 'Summer 2026, 2 photos' }).click()
  await expect(grid(friend)).toHaveAttribute('data-count', '2')

  // "Download album" is a zip the server builds from the cleaned originals.
  const zipRequest = friend.context().waitForEvent('request', (r) => r.url().includes('/photos/zip/'))
  await friend.getByTestId('photos-download').click()
  const zip = Buffer.from(await (await fetch((await zipRequest).url())).arrayBuffer())
  expect(zipNames(zip)).toHaveLength(2)
  for (const secret of SECRETS) expect(zip.includes(secret), secret).toBe(false)
  await friend.getByTestId('photos-album-back').click()
  await friend.getByTestId('photos-tab-photos').click()

  // The friend adds a photo without its date: the file keeps none, and the filter by person finds it.
  await addPhotos(friend, ['gps.jpg'], { keepDate: false })
  await expect(grid(host)).toHaveAttribute('data-count', '5')
  await expect(host.locator('.photo-month')).toHaveCount(2)
  expect(storedUploads().filter((bytes) => bytes.includes('2024:07:14 18:30:05'))).toHaveLength(1)
  await host.getByTestId('photos-person').selectOption({ label: 'Friend (1)' })
  await expect(grid(host)).toHaveAttribute('data-count', '1')
  await host.getByTestId('photos-person').selectOption({ label: 'Everyone' })
  // Oldest first puts July 2024 on top.
  await host.getByTestId('photos-sort').selectOption('oldest')
  await expect(host.locator('.photo-month').first()).toHaveText('July 2024')
  await host.getByTestId('photos-sort').selectOption('newest')

  // The storage limit: the owner sets 1 MB; "x of y used" shows, and a file that doesn't fit is refused.
  await host.getByTestId('photos-storage').click()
  const storage = host.getByRole('dialog', { name: 'Storage' })
  await expect(storage.getByTestId('photos-usage')).toContainText('used')
  await storage.getByTestId('photos-cap-input').fill('1')
  await storage.getByTestId('photos-cap-unit').selectOption('MB')
  await storage.getByTestId('photos-cap-save').click()
  await expect(storage.getByTestId('photos-usage')).toContainText(/of 1(\.0)? MB used/)
  await host.screenshot({ path: join(SHOTS, 'photos-storage.png') })
  await storage.getByRole('button', { name: 'Close' }).last().click()
  await expect(friend.getByTestId('photos-storage')).toContainText('/ 1')
  // A 1.5 MB PNG (a real header, then noise).
  const big = Buffer.concat([readFileSync(fixture('screenshot.png')).subarray(0, 33), pngChunk('IDAT', Buffer.alloc(1_500_000, 7)), pngChunk('IEND', Buffer.alloc(0))])
  await friend.getByTestId('photos-file-input').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: big })
  await friend.getByTestId('photos-add-confirm').click()
  await expect(friend.getByTestId('photos-upload')).toContainText("This channel's photo storage is full (1 MB)")
  await expect(grid(host)).toHaveAttribute('data-count', '5')
  // Members can't change the limit.
  await friend.getByTestId('photos-storage').click()
  await expect(friend.getByRole('dialog', { name: 'Storage' }).getByTestId('photos-cap-input')).toHaveCount(0)
  await friend.keyboard.press('Escape')

  // Clean-up: the friend may delete only their own; the owner selects everything and deletes it.
  await friend.getByTestId('photos-select').click()
  await friend.getByTestId('photos-select-all').click()
  await expect(friend.getByTestId('photos-delete')).toBeDisabled()
  await friend.getByTestId('photos-select').click()
  await host.getByTestId('photos-select').click()
  await host.getByTestId('photos-select-all').click()
  await expect(host.getByTestId('photos-selection')).toContainText('5 selected')
  await host.getByTestId('photos-delete').click()
  await host.getByRole('dialog', { name: 'Delete 5 photos?' }).getByTestId('photos-confirm').click()
  await expect(host.getByTestId('photos-empty')).toBeVisible()
  await expect(friend.getByTestId('photos-empty')).toBeVisible()
  // The files are gone from the server too.
  await expect.poll(() => storedUploads().filter((bytes) => bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).length).toBe(0)
})

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)]) // the cleaner doesn't check the CRC; no viewer ever decodes this one
}

test('an end-to-end encrypted photos channel: the server holds only ciphertext', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friendContext = await browser.newContext({ acceptDownloads: true })
  // Without a save picker the zip is saved like any download, which the test can read.
  await friendContext.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  })
  const friend = await friendContext.newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await host.locator('.member-list').getByRole('button', { name: 'Friend' }).waitFor()

  await createPhotosChannel(host, 'family', true)
  await expect(host.getByTestId('e2ee-lock').first()).toBeVisible()
  await friend.locator('.channel-list .channel', { hasText: 'family' }).click()
  await expect(friend.getByTestId('photos-empty')).toBeVisible()

  // The host adds a photo and a video to a new album; the dialog says the files are encrypted on the device.
  await host.getByTestId('photos-file-input').setInputFiles(['gps.jpg', 'clip.mp4'].map(fixture))
  const dialog = host.getByRole('dialog', { name: 'Add 2 files' })
  await expect(dialog.getByTestId('photos-privacy-note')).toContainText('encrypted on this device')
  await dialog.getByTestId('photos-add-album').selectOption('new')
  await dialog.getByTestId('photos-add-album-name').fill('Midsummer')
  await dialog.getByTestId('photos-add-confirm').click()
  await expect(grid(host)).toHaveAttribute('data-count', '2')

  // The friend's app decrypts the thumbnails and the album's name.
  await expect(grid(friend)).toHaveAttribute('data-count', '2')
  await expect.poll(() => tiles(friend).locator('img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0 && (i as HTMLImageElement).src.startsWith('blob:')).length)).toBe(2)
  await friend.getByTestId('photos-tab-albums').click()
  await friend.getByTestId('photos-albums').getByRole('button', { name: 'Midsummer, 2 photos' }).click()
  await expect(friend.getByTestId('photos-album-title')).toHaveText('Midsummer')

  // On the server: no picture or video as such, nothing readable from them, not the album's name or a file name.
  const stored = storedUploads()
  expect(stored.length).toBe(4)
  for (const bytes of stored) {
    expect(bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(false)
    expect(bytes.subarray(4, 8).toString('latin1')).not.toBe('ftyp')
    for (const secret of [...SECRETS, '2024:07:14', 'vp09', 'JFIF']) expect(bytes.includes(secret), secret).toBe(false)
  }
  const database = readdirSync(server.world).filter((name) => /\.(db|sqlite)/.test(name)).map((name) => readFileSync(join(server.world, name)))
  expect(database.length).toBeGreaterThan(0)
  for (const text of ['Midsummer', 'gps.jpg', 'clip.mp4']) expect(database.some((bytes) => bytes.includes(text)), text).toBe(false)

  // The viewer downloads, checks and decrypts the original; captions are sealed too.
  await tiles(friend).last().locator('.photo-open').click()
  const viewer = friend.getByTestId('photo-viewer')
  await expect(viewer.getByTestId('photo-viewer-image')).toBeVisible()
  await expect(viewer.getByTestId('photo-viewer-uploader')).toHaveText('Host')
  await expect(viewer.getByTestId('photo-viewer-date')).toContainText('2024')
  await viewer.getByTestId('photo-comments').click()
  const box = viewer.getByPlaceholder(/Reply/)
  await box.fill('Sealed comment')
  await box.press('Enter')
  await expect(viewer.locator('.thread-panel .message', { hasText: 'Sealed comment' })).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'photos-encrypted-viewer.png') })
  await friend.keyboard.press('Escape')
  await friend.keyboard.press('Escape')
  await host.locator('.photo-tile.image .photo-open').click()
  await host.getByTestId('photo-caption-add').click()
  await host.getByTestId('photo-caption-input').fill('Sealed caption')
  await host.getByTestId('photo-caption-save').click()
  await expect(host.getByTestId('photo-caption')).toHaveText('Sealed caption')
  await host.getByTestId('photo-viewer-close').click()
  await tiles(friend).last().locator('.photo-open').click()
  await expect(friend.getByTestId('photo-caption')).toHaveText('Sealed caption')
  await friend.getByTestId('photo-viewer-close').click()
  for (const text of ['Sealed caption', 'Sealed comment']) {
    expect(readdirSync(server.world).filter((name) => /\.(db|sqlite)/.test(name)).some((name) => readFileSync(join(server.world, name)).includes(text)), text).toBe(false)
  }

  // "Download album": the friend's app decrypts the files and writes the zip itself.
  const download = friend.waitForEvent('download')
  await friend.getByTestId('photos-download').click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe('Midsummer.zip')
  const zip = readFileSync(await saved.path())
  expect(zipNames(zip).sort()).toEqual(['clip.mp4', 'gps.jpg'])
  expect(zip.includes('JFIF')).toBe(true)
  expect(zip.includes('vp09')).toBe(true)
  for (const secret of SECRETS) expect(zip.includes(secret), secret).toBe(false)
  await host.screenshot({ path: join(SHOTS, 'photos-encrypted.png') })
})

test('photos on a phone: the grid, adding from the phone and the viewer fit the screen', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await createPhotosChannel(host, 'holiday')
  await addPhotos(host, ['gps.jpg', 'screenshot.png', 'wide.jpg'])
  await expect(grid(host)).toHaveAttribute('data-count', '3')

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await phoneContext.newPage()
  await joinVia(phone, await createInviteLink(host), 'Pocket')
  await phone.getByRole('button', { name: 'Open channels' }).first().click()
  await phone.locator('.channel-list .channel', { hasText: 'holiday' }).click()
  await expect(grid(phone)).toHaveAttribute('data-count', '3')
  // The picker takes many photos and videos at once.
  await expect(phone.getByTestId('photos-file-input')).toHaveAttribute('multiple', '')
  await expect(phone.getByTestId('photos-file-input')).toHaveAttribute('accept', /image\/jpeg.*video\/mp4/)
  await addPhotos(phone, ['clip.mp4', 'wide.jpg'], { newAlbum: 'From my phone' })
  await expect(grid(phone)).toHaveAttribute('data-count', '5')
  await expect(grid(host)).toHaveAttribute('data-count', '5')
  await expect(phone.getByTestId('photos-uploads-summary')).toHaveText('2 files added')
  await phone.waitForTimeout(350)
  await phone.screenshot({ path: join(SHOTS, 'photos-phone.png') })
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  // Rows fill the width; nothing is cut off at the right edge.
  const widest = await tiles(phone).evaluateAll((els) => Math.max(...els.map((el) => el.getBoundingClientRect().right)))
  expect(widest).toBeLessThanOrEqual(390)

  // A tap opens the viewer; its comments sit below the picture.
  const first = tiles(phone).first().locator('.photo-open')
  const point = await first.boundingBox()
  await phone.touchscreen.tap(point!.x + 20, point!.y + 20)
  const viewer = phone.getByTestId('photo-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('.photo-nav.next')).toBeHidden()
  await viewer.getByTestId('photo-comments').click()
  await expect(viewer.locator('.thread-panel')).toBeVisible()
  await phone.waitForTimeout(350)
  await phone.screenshot({ path: join(SHOTS, 'photos-phone-viewer.png') })
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await viewer.getByTestId('photo-comments').click()
  await viewer.getByTestId('photo-viewer-close').click()
  await phone.getByTestId('photos-tab-albums').click()
  await expect(phone.getByTestId('photos-albums').getByRole('button', { name: 'From my phone, 2 photos' })).toBeVisible()
  await phone.screenshot({ path: join(SHOTS, 'photos-phone-albums.png') })

  const a11y = await new AxeBuilder({ page: host }).include('[data-testid="photos-channel"]').analyze()
  expect(a11y.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => v.id)).toEqual([])
})

test('HEIC, AVIF and GIF, a video this browser cannot decode, the unread mark with its notification, and the share sheet', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friendContext = await browser.newContext()
  // Desktop notifications are recorded instead of shown.
  await friendContext.addInitScript(() => {
    const shown: { title: string; body?: string }[] = []
    ;(window as unknown as { shownNotifications: typeof shown }).shownNotifications = shown
    class Recorded {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      onclick: (() => void) | null = null
      constructor(title: string, options?: { body?: string }) {
        shown.push({ title, body: options?.body })
      }
      close() {}
    }
    ;(window as unknown as { Notification: unknown }).Notification = Recorded
  })
  const friend = await friendContext.newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await createPhotosChannel(host, 'holiday')
  const row = friend.locator('.channel-list .channel', { hasText: 'holiday' })
  await expect(row).toBeVisible()
  await expect(row).not.toHaveClass(/unread/)

  // An iPhone photo (HEIC), an AVIF, an animated GIF and an HEVC video, which this browser can't decode.
  await addPhotos(host, ['iphone.heic', 'pixel.avif', 'clip.gif', 'hevc.mp4'])
  await expect(grid(host)).toHaveAttribute('data-count', '4', { timeout: 30_000 })
  await expect(host.getByTestId('photos-uploads-summary')).toHaveText('4 files added')

  // The friend is elsewhere: the channel turns unread and one notification says what happened.
  await expect(row).toHaveClass(/unread/)
  const notes = () => friend.evaluate(() => (window as unknown as { shownNotifications: { title: string; body?: string }[] }).shownNotifications)
  await expect.poll(notes).toEqual([{ title: expect.stringContaining('Host in #holiday'), body: 'Added 4 photos' }])
  await row.click()
  await expect(grid(friend)).toHaveAttribute('data-count', '4')
  await expect(row).not.toHaveClass(/unread/)
  // Three thumbnails drew; the video nobody here can decode shows a play tile instead of a broken picture.
  await expect.poll(() => tiles(friend).locator('img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length)).toBe(3)
  const playTile = friend.locator('.photo-tile.video')
  await expect(playTile.locator('.photo-blank svg')).toBeVisible()
  await expect(playTile.locator('img')).toHaveCount(0)
  await expect(playTile.locator('.photo-badge.video')).toHaveText('Video')
  await friend.screenshot({ path: join(SHOTS, 'photos-formats.png') })

  // Back in #general, a second batch right after marks the channel unread again without another notification.
  await friend.locator('.channel-list .channel', { hasText: 'general' }).click()
  await addPhotos(host, ['wide.jpg'])
  await expect(grid(host)).toHaveAttribute('data-count', '5')
  await expect(row).toHaveClass(/unread/)
  expect(await notes()).toHaveLength(1)

  // Stored: the HEIC and AVIF originals and the GIF, all without what identified them.
  const stored = storedUploads()
  for (const secret of [...SECRETS, 'xmpmeta', 'XMP Data']) expect(stored.some((bytes) => bytes.includes(secret)), secret).toBe(false)
  expect(stored.filter((bytes) => bytes.subarray(4, 12).toString('latin1') === 'ftypheic')).toHaveLength(1)
  expect(stored.filter((bytes) => bytes.subarray(4, 12).toString('latin1') === 'ftypavif')).toHaveLength(1)
  expect(stored.filter((bytes) => bytes.subarray(0, 6).toString('latin1') === 'GIF89a' && bytes.includes('NETSCAPE2.0'))).toHaveLength(1)

  // The viewer shows the JPEG made for display; the download is the original HEIC or AVIF. The GIF is shown as it is.
  await host.locator('.photo-month', { hasText: 'December 2023' }).scrollIntoViewIfNeeded()
  await tiles(host).last().locator('.photo-open').click()
  const viewer = host.getByTestId('photo-viewer')
  const image = viewer.getByTestId('photo-viewer-image')
  await expect(image).toHaveAttribute('src', /display\.jpg$/)
  await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(320)
  await expect(viewer.getByTestId('photo-download')).toHaveAttribute('href', /\.(heic|avif)$/i)
  await expect(viewer.getByTestId('photo-viewer-date')).toContainText('2023')
  let sawGif = false
  for (let i = 0; i < 4 && !sawGif; i++) {
    await host.keyboard.press('ArrowLeft')
    sawGif = await viewer.getByTestId('photo-viewer-image').getAttribute('src', { timeout: 2000 }).then((src) => /clip\.gif$/.test(src ?? ''), () => false)
  }
  expect(sawGif).toBe(true)
  await host.getByTestId('photo-viewer-close').click()

  // "Share to Iskra" from another app: a photos channel takes the picture as a photo.
  await friend.waitForFunction(() => typeof (window as { iskraShare?: unknown }).iskraShare === 'function')
  await friend.evaluate(async () => {
    const canvas = new OffscreenCanvas(480, 320)
    const g = canvas.getContext('2d')!
    g.fillStyle = '#e0703c'
    g.fillRect(0, 0, 480, 320)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    ;(window as unknown as { iskraShare: (raw: unknown) => boolean }).iskraShare({ id: 'p1', files: [{ name: 'from-gallery.png', type: 'image/png', size: blob.size, url: URL.createObjectURL(blob) }] })
  })
  const picker = friend.getByRole('dialog', { name: 'Share to…' })
  await picker.getByRole('radio', { name: /^#holiday/ }).click()
  await picker.getByRole('button', { name: 'Send to #holiday' }).click()
  await expect(picker).toHaveCount(0)
  await expect(grid(friend)).toHaveAttribute('data-count', '6')
  await expect(grid(host)).toHaveAttribute('data-count', '6')
})
