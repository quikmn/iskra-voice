// Calls on a phone: a camera held upright is shown whole (on both sides), and a microphone that can't start says why
// instead of blaming permissions. Fake devices only: the "phone camera" is a drawn canvas.
import { join } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, VOICE_JOIN } from './helpers'

const { defaultBrowserType: _b, ...pixel } = devices['Pixel 7']

/** The camera of a phone held upright: a 360x640 picture with a face-sized disc in its lower half, as you hold a phone. */
function uprightCamera() {
  const md = navigator.mediaDevices
  const real = md.getUserMedia.bind(md)
  md.getUserMedia = async (constraints) => {
    if (!constraints?.video) return real(constraints)
    const canvas = document.createElement('canvas')
    canvas.width = 360
    canvas.height = 640
    const g = canvas.getContext('2d')!
    const draw = () => {
      g.fillStyle = '#123a5a'
      g.fillRect(0, 0, 360, 640)
      g.fillStyle = '#ffd9a0'
      g.beginPath()
      g.arc(180, 470, 90, 0, Math.PI * 2)
      g.fill()
    }
    draw()
    setInterval(draw, 100)
    return canvas.captureStream(15)
  }
}

/** Where the picture is drawn inside its tile: the video box and the tile's, and how the picture is fitted. */
const tileBoxes = (page: Page, tile: string) =>
  page.locator(tile).evaluate((el) => {
    const video = el.querySelector('video')!
    const t = el.getBoundingClientRect()
    const v = video.getBoundingClientRect()
    return { tile: [t.top, t.bottom], video: [v.top, v.bottom], fit: getComputedStyle(video).objectFit, size: [video.videoWidth, video.videoHeight] }
  })

test.describe('calls on a phone', () => {
  test.skip(!hasLiveKit(), 'needs LiveKit in .tools')

  test('an upright camera is shown whole in its tile, for you and for the others', async ({ browser }) => {
    const server = await startServer('Phone media', true)
    try {
      const host = await (await browser.newContext()).newPage()
      await joinVia(host, server.ownerLink(), 'Host')
      await host.getByRole('button', { name: 'Create voice channel' }).click()
      await host.getByRole('radio', { name: 'Voice' }).click()
      await host.getByLabel('Name').fill('talk')
      await host.getByRole('button', { name: 'Create', exact: true }).click()
      const link = await createInviteLink(host)

      const context = await browser.newContext({ ...pixel, permissions: ['microphone', 'camera'] })
      await context.addInitScript(uprightCamera)
      const phone = await context.newPage()
      await joinVia(phone, link, 'Phone')
      await phone.getByRole('button', { name: 'Open channels' }).click()
      await phone.getByTitle('Join talk').click()
      await expect(phone.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
      await host.getByTitle('Join talk').click()
      await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)

      await phone.getByRole('button', { name: 'Turn camera on' }).first().click()
      for (const page of [phone, host]) {
        const tile = '.video-tile.camera.portrait'
        await expect(page.locator(tile)).toBeVisible({ timeout: 20_000 })
        // The tile knows it's portrait from the track; the video element has its size once the first frame is decoded.
        await expect.poll(() => page.locator(`${tile} video`).evaluate((v: HTMLVideoElement) => v.videoHeight)).toBeGreaterThan(0)
        const box = await tileBoxes(page, tile)
        expect(box.size[1]).toBeGreaterThan(box.size[0])
        expect(box.fit).toBe('contain')
        // The picture's box is the tile's: nothing of a tall picture hangs out above and below it, cut off.
        expect(box.video[0]).toBeGreaterThanOrEqual(box.tile[0] - 1)
        expect(box.video[1]).toBeLessThanOrEqual(box.tile[1] + 1)
      }
      await phone.screenshot({ path: join(SHOTS, 'phone-media-upright-self.png') })
      await host.locator('.video-tile.camera.portrait').screenshot({ path: join(SHOTS, 'phone-media-upright-seen.png') })
    } finally {
      await server.stop()
    }
  })

  test('a remembered microphone that is gone: the call uses the default one, as the settings test does', async ({ browser }) => {
    const server = await startServer('Phone old mic', true)
    try {
      const context = await browser.newContext({ ...pixel, permissions: ['microphone'] })
      // Phones hand out new device ids (after an update, or when the app's data is reset): the saved one no longer exists.
      await context.addInitScript(() => {
        localStorage.setItem('iskra.audio', JSON.stringify({ v: 3, inputDevice: 'a-microphone-that-is-gone' }))
        // Counts the microphones the app actually got.
        const md = navigator.mediaDevices
        const real = md.getUserMedia.bind(md)
        const w = window as unknown as { micsOpened: number }
        w.micsOpened = 0
        md.getUserMedia = async (constraints) => {
          const stream = await real(constraints)
          if (stream.getAudioTracks().some((t) => t.readyState === 'live')) w.micsOpened++
          return stream
        }
      })
      const phone = await context.newPage()
      await joinVia(phone, server.ownerLink(), 'Phone')
      await phone.getByRole('button', { name: 'Open channels' }).click()
      await phone.getByRole('button', { name: 'Create voice channel' }).click()
      await phone.getByRole('radio', { name: 'Voice' }).click()
      await phone.getByLabel('Name').fill('talk')
      await phone.getByRole('button', { name: 'Create', exact: true }).click()
      await phone.getByTitle('Join talk').click()
      await expect(phone.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
      // The call got a microphone (before the fix both tries asked for the gone one and failed).
      await expect.poll(() => phone.evaluate(() => (window as unknown as { micsOpened: number }).micsOpened), { timeout: 15_000 }).toBeGreaterThan(0)
      await expect(phone.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })).toBeVisible()
      // It says which one it is on, with a way to choose; picking one puts the note away.
      const note = phone.locator('.stage').getByTestId('voice-error')
      await expect(note).toContainText("The microphone you picked isn't available, so the default one is used.")
      await note.getByRole('button', { name: 'Choose microphone' }).click()
      const sheet = phone.getByRole('dialog', { name: 'Choose a microphone' })
      await expect(sheet.getByRole('menuitemradio', { name: 'System default' })).toHaveAttribute('aria-checked', 'true')
      await sheet.getByRole('menuitemradio', { name: 'Fake Audio Input 1' }).click()
      await expect(note).toHaveCount(0)
      await expect(phone.locator('.call-controls').getByRole('button', { name: 'Mute', exact: true })).toBeVisible()
    } finally {
      await server.stop()
    }
  })

  test("a microphone that won't open says so, not \"check your permissions\"", async ({ browser }) => {
    const server = await startServer('Phone mic', true)
    try {
      const context = await browser.newContext({ ...pixel, permissions: ['microphone'] })
      await context.addInitScript(() => {
        // As Android's web view answers when the audio source can't be started.
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException('Could not start audio source', 'NotReadableError')
        }
      })
      const phone = await context.newPage()
      await joinVia(phone, server.ownerLink(), 'Phone')
      await phone.getByRole('button', { name: 'Open channels' }).click()
      await phone.getByRole('button', { name: 'Create voice channel' }).click()
      await phone.getByRole('radio', { name: 'Voice' }).click()
      await phone.getByLabel('Name').fill('talk')
      await phone.getByRole('button', { name: 'Create', exact: true }).click()
      await phone.getByTitle('Join talk').click()
      await expect(phone.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
      const error = phone.locator('.stage').getByTestId('voice-error')
      await expect(error).toContainText("Couldn't open your microphone. Another app may be using it.")
      await expect(error).not.toContainText('permissions')
    } finally {
      await server.stop()
    }
  })
})
