// Listen together: a watch party's queue (add, reorder, remove, who may), audio-only mode with the now-playing bar,
// moving on by itself when an item ends, and the queue as a bottom sheet on a phone.
import { expect, test, type Page } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

const FILM = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'party.webm') // 20 s test pattern with a tone

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Listen Test', true)
})
test.afterAll(async () => server?.stop())

const jukebox = (page: Page) => page.locator('.voice-channel', { hasText: 'jukebox' })
const party = (page: Page) => page.locator('.watch-party')
const queue = (page: Page) => page.getByTestId('watch-queue')
const items = (page: Page) => page.getByTestId('watch-queue-item')

async function joinJukebox(page: Page) {
  await jukebox(page).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
}

test('a queue plays on by itself, the host can make it audio only, and phones get a sheet', async ({ browser }) => {
  test.setTimeout(240_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('jukebox')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  const invite = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, invite, 'Friend')
  await joinJukebox(host)
  await joinJukebox(friend)

  // The party starts with an uploaded track; the queue is empty.
  await host.locator('.call-controls').getByRole('button', { name: 'Watch together' }).click()
  const dialog = host.getByRole('dialog', { name: 'Watch together' })
  await dialog.getByLabel('Title (optional)').fill('Track 1')
  await dialog.locator('input[type=file]').setInputFiles(FILM)
  await expect(party(host)).toContainText('Track 1')
  await expect(party(friend)).toContainText('Track 1')
  await host.getByTestId('watch-queue-button').click()
  await expect(queue(host)).toContainText('Nothing queued yet')

  // The host queues a link and an upload; the friend sees the queue but can't touch it.
  await queue(host).getByLabel('Link').fill('https://media.example.com/song-b.mp3')
  await queue(host).getByLabel('Title (optional)').fill('Song B')
  await queue(host).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(items(host)).toHaveCount(1)
  await queue(host).getByLabel('Title (optional)').fill('Track 2')
  await queue(host).locator('input[type=file]').setInputFiles(FILM)
  await expect(items(host)).toHaveCount(2)
  await expect(items(host).nth(1)).toContainText('Track 2')
  await friend.getByTestId('watch-queue-button').click()
  await expect(items(friend)).toHaveCount(2)
  await expect(queue(friend).getByRole('button', { name: /Remove from queue/ })).toHaveCount(0)

  // Reorder and remove: Track 2 first, Song B gone.
  await queue(host).getByRole('button', { name: 'Move up: Track 2' }).click()
  await expect(items(host).first()).toContainText('Track 2')
  await expect(items(friend).first()).toContainText('Track 2')
  await queue(host).getByRole('button', { name: 'Remove from queue: Song B' }).click()
  await expect(items(host)).toHaveCount(1)
  await host.screenshot({ path: join(SHOTS, 'listen-queue.png') })

  // Audio only: everyone gets the now-playing bar instead of the video, with what's next.
  await host.getByLabel('Audio only').click() // applied once the server confirms
  await expect(host.getByLabel('Audio only')).toBeChecked()
  for (const page of [host, friend]) {
    await expect(page.locator('.watch-main.audio-only')).toBeVisible()
    await expect(page.getByTestId('watch-now-playing')).toContainText('Up next: Track 2')
  }
  await host.screenshot({ path: join(SHOTS, 'listen-audio-only.png') })

  // Play at double speed: the 20 s track ends in about 10, and the party moves on to Track 2 for everyone.
  await host.getByRole('combobox', { name: 'Speed' }).selectOption('2')
  await host.locator('.watch-controls').getByRole('button', { name: 'Play' }).click()
  for (const page of [host, friend]) {
    await expect(page.getByTestId('watch-now-playing')).toContainText('Now playing', { timeout: 5_000 })
    await expect(page.getByTestId('watch-now-playing').locator('strong')).toHaveText('Track 2', { timeout: 40_000 })
    await expect(page.getByTestId('watch-now-playing')).toContainText('Last one')
  }
  await expect(items(host)).toHaveCount(0)

  // Anyone can control: the friend can queue something too, and skip to it.
  await host.getByLabel('Anyone can control').click() // applied once the server confirms
  await expect(host.getByLabel('Anyone can control')).toBeChecked()
  await queue(friend).getByLabel('Link').fill('https://media.example.com/song-c.mp3')
  await queue(friend).getByLabel('Title (optional)').fill('Song C')
  await queue(friend).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(items(host)).toHaveCount(1)
  await friend.getByTestId('watch-next').click()
  await expect(host.getByTestId('watch-now-playing').locator('strong')).toHaveText('Song C')

  // Phones: the queue (still open) becomes a sheet from the bottom.
  await friend.setViewportSize({ width: 390, height: 844 })
  await expect(friend.locator('.watch-queue-sheet')).toBeVisible()
  await expect(friend.locator('.watch-queue-sheet')).toContainText('Up next')
  await friend.screenshot({ path: join(SHOTS, 'listen-queue-phone.png') })
  await friend.keyboard.press('Escape')
  await expect(friend.locator('.watch-queue-sheet')).toHaveCount(0)
})
