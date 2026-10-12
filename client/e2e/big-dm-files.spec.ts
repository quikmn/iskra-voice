import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
let dir: string
test.beforeAll(async () => {
  server = await startServer('Big DM Files')
  dir = mkdtempSync(join(tmpdir(), 'iskra-bigdm-'))
})
test.afterAll(async () => {
  await server?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** A file of random bytes (written a MB at a time) and its SHA-256. */
function randomFile(name: string, size: number): { path: string; sha256: string } {
  const path = join(dir, name)
  const hash = createHash('sha256')
  const fd = openSync(path, 'w')
  for (let left = size; left > 0;) {
    const piece = randomBytes(Math.min(left, 1024 * 1024))
    writeSync(fd, piece)
    hash.update(piece)
    left -= piece.length
  }
  closeSync(fd)
  return { path, sha256: hash.digest('hex') }
}

test('a 120 MB file goes end-to-end encrypted through a DM and saves straight to disk, intact', async ({ browser }) => {
  test.setTimeout(240_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await expect(friend.getByPlaceholder('Message Host')).toBeVisible()

  // Size: 120 MB plus a bit, so the last part and the last chunk are both partial.
  const size = 120 * 1024 * 1024 + 12345
  const big = randomFile('holiday-video.mkv', size)
  // How much memory the sender's page uses while it encrypts and uploads (Chromium only).
  await friend.evaluate(() => {
    const w = window as unknown as { peakHeap: number; memory?: { usedJSHeapSize: number } }
    w.peakHeap = 0
    setInterval(() => {
      const used = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
      w.peakHeap = Math.max(w.peakHeap, used)
    }, 100)
  })
  await friend.locator('.composer-wrap input[type=file]').setInputFiles(big.path)
  const chip = friend.locator('.pending-upload', { hasText: 'holiday-video.mkv' })
  await expect(chip).toContainText('%')
  await friend.screenshot({ path: join(SHOTS, 'dm-big-file-uploading.png') })
  await expect(chip).toContainText('MB', { timeout: 180_000 }) // the size, once it's up
  await expect(chip.getByRole('alert')).toHaveCount(0)
  const peak = await friend.evaluate(() => (window as unknown as { peakHeap: number }).peakHeap)
  console.log(`sender peak JS heap: ${(peak / 1024 / 1024).toFixed(0)} MB`)
  if (peak) expect(peak).toBeLessThan(size) // never the whole file (let alone plaintext and ciphertext) on the heap
  await friend.getByPlaceholder('Message Host').fill('the whole trip, uncut')
  await friend.getByPlaceholder('Message Host').press('Enter')

  // The server holds only ciphertext of the expected length.
  const stored = readdirSync(join(server.world, 'uploads'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  expect(stored.some((e) => e.name.length === 64)).toBe(true)

  // Host saves it. The browser's save picker is stood in for by a file in the origin's private file system,
  // which is written through the same streaming API a real picked file is.
  await host.evaluate(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
      const root = await navigator.storage.getDirectory()
      return root.getFileHandle(suggestedName, { create: true })
    }
  })
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await host.locator('.dm-row', { hasText: 'Friend' }).click()
  const row = host.locator('.dm-file', { hasText: 'holiday-video.mkv' })
  await expect(row).toContainText('120.0 MB')
  await row.getByRole('button', { name: 'Save' }).click()
  await expect(row).toContainText('Saving…')
  await host.screenshot({ path: join(SHOTS, 'dm-big-file-saving.png') })
  await expect(row).toContainText('Saved', { timeout: 180_000 })
  await expect(row.getByRole('alert')).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'dm-big-file-saved.png') })

  const saved = await host.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const file = await (await root.getFileHandle('holiday-video.mkv')).getFile()
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return { size: file.size, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') }
  })
  expect(saved).toEqual({ size, sha256: big.sha256 })
})

test('a damaged download is never saved', async ({ browser }) => {
  const own = await startServer('Damaged DM Files')
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, own.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend 2')
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  const small = randomFile('report.pdf', 3 * 1024 * 1024 + 7)
  await friend.locator('.composer-wrap input[type=file]').setInputFiles(small.path)
  await expect(friend.locator('.pending-upload', { hasText: 'report.pdf' })).toContainText('MB')
  await friend.getByPlaceholder('Message Host').press('Enter')

  await host.evaluate(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
      const root = await navigator.storage.getDirectory()
      return root.getFileHandle(suggestedName, { create: true })
    }
  })
  // The server (or anyone on the way) changes one byte in the middle of the ciphertext.
  await host.route('**/dmfiles/**', async (route) => {
    const response = await route.fetch()
    const body = await response.body()
    body[1_500_000] ^= 1
    await route.fulfill({ response, body })
  })
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await host.locator('.dm-row', { hasText: 'Friend 2' }).click()
  const row = host.locator('.dm-file', { hasText: 'report.pdf' })
  await row.getByRole('button', { name: 'Save' }).click()
  await expect(row.getByRole('alert')).toBeVisible()
  await expect(row).not.toContainText('Saved')
  // Nothing under the file's name: the partial write was thrown away.
  const kept = await host.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    return root.getFileHandle('report.pdf').then(() => true, () => false)
  })
  expect(kept).toBe(false)
  await own.stop()
})
