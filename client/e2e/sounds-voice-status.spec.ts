// Notification sounds and voice channel status. A status set in a call shows for another member under the channel and
// in their call, and it goes away when everyone has left. Sounds: pick one for mentions and preview it, pick one for a
// channel from its menu, and upload your own (it stays on the device) and preview that.
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Sounds Test', true)
})
test.afterAll(async () => server?.stop())

test.describe.configure({ mode: 'serial' })
/** The first test's invite, for the second (the owner link works once). */
let invite = ''

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })

/** Counts the sounds that start playing (synthesized notes and sound buffers). */
async function countSounds(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __notes: number; __buffers: number }
    w.__notes = 0
    w.__buffers = 0
    const osc = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (...args: Parameters<typeof osc>) {
      w.__notes++
      return osc.apply(this, args)
    }
    const buf = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof buf>) {
      w.__buffers++
      return buf.apply(this, args)
    }
  })
}
const played = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __notes: number; __buffers: number }
  return { __notes: w.__notes, __buffers: w.__buffers }
})

/** A short 16-bit mono WAV of a sine tone. */
function wav(seconds: number, rate = 8000): Buffer {
  const n = Math.round(seconds * rate)
  const out = Buffer.alloc(44 + n * 2)
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8); out.write('fmt ', 12)
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 660 * i) / rate) * 20000), 44 + i * 2)
  return out
}

test('voice status: set in the call, seen by others, cleared when everyone leaves', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).first().click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(lounge(host)).toBeVisible()
  const friend = await (await browser.newContext()).newPage()
  invite = await createInviteLink(host)
  await joinVia(friend, invite, 'Friend')

  // The host joins and sets a status from the call.
  await lounge(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  const bar = host.getByTestId('voice-status-bar')
  await expect(bar).toContainText('No status yet')
  await bar.getByRole('button', { name: 'Set a status' }).click()
  const editor = host.getByTestId('voice-status-editor')
  const field = editor.getByLabel('Voice channel status')
  await field.fill('x'.repeat(61))
  await expect(editor.getByRole('alert')).toHaveText('Up to 60 characters.')
  await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled()
  await field.fill('CS2 ranked 🔫')
  await expect(editor).toContainText('12/60')
  await host.screenshot({ path: join(SHOTS, 'voice-status-editing.png') })
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(bar).toContainText('CS2 ranked 🔫')

  // The friend sees it under the channel, joins, and sees it in the call too.
  await expect(lounge(friend).getByTestId('voice-status-line')).toHaveText('CS2 ranked 🔫')
  await expect(lounge(friend).getByTestId('voice-status-line')).toHaveAttribute('title', 'Status set by Host')
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected')
  await expect(friend.getByTestId('voice-status-bar')).toContainText('CS2 ranked 🔫')
  await friend.screenshot({ path: join(SHOTS, 'voice-status-call.png') })

  // Phone width: the call's status bar still fits.
  await friend.setViewportSize({ width: 390, height: 800 })
  await expect(friend.getByTestId('voice-status-bar')).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'voice-status-phone.png') })
  await friend.setViewportSize({ width: 1280, height: 800 })
  await friend.getByRole('button', { name: 'Leave voice' }).click()

  // The last one leaves: the status goes for everyone.
  await host.getByRole('button', { name: 'Leave voice' }).click()
  await expect(lounge(friend).getByTestId('voice-status-line')).toHaveCount(0, { timeout: 15_000 })
  await expect(lounge(host).getByTestId('voice-status-line')).toHaveCount(0)
})

test('notification sounds: pick and preview, a channel sound, your own sound', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await countSounds(page)
  await joinVia(page, invite, 'Listener')

  await openSettings(page, 'Notifications')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const mentions = dialog.getByTestId('sound-mention')
  await expect(mentions.getByRole('combobox')).toHaveValue('classic')
  await mentions.getByRole('combobox').selectOption('bell')
  await expect.poll(async () => (await played(page)).__notes).toBeGreaterThan(0) // picking plays it
  const before = (await played(page)).__notes
  await mentions.getByRole('button', { name: 'Play Bell' }).click()
  await expect.poll(async () => (await played(page)).__notes).toBeGreaterThan(before)

  // Your own sound: checked here, kept on this device, and offered as a choice.
  const custom = dialog.getByTestId('sound-custom')
  await custom.getByLabel('Upload a sound').setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('nope') })
  await expect(custom.getByRole('alert')).toHaveText("That isn't a sound file.")
  await custom.getByLabel('Upload a sound').setInputFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: wav(6) })
  await expect(custom.getByRole('alert')).toHaveText('That sound is too long. Pick one up to 4 seconds.')
  await custom.getByLabel('Upload a sound').setInputFiles({ name: 'ding.wav', mimeType: 'audio/wav', buffer: wav(0.5) })
  await expect(custom).toContainText('ding.wav (0.5 s)')
  await expect.poll(async () => (await played(page)).__buffers).toBeGreaterThan(0)
  await dialog.getByTestId('sound-dm').getByRole('combobox').selectOption('custom')
  await custom.getByRole('button', { name: 'Play Your own sound' }).click()
  await expect.poll(async () => (await played(page)).__buffers).toBeGreaterThan(1)
  await custom.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(SHOTS, 'sounds-settings.png') })
  // It stays after a reload (this device), and so do the choices.
  await page.reload()
  await openSettings(page, 'Notifications')
  await expect(dialog.getByTestId('sound-custom')).toContainText('ding.wav (0.5 s)')
  await expect(dialog.getByTestId('sound-dm').getByRole('combobox')).toHaveValue('custom')
  await expect(dialog.getByTestId('sound-mention').getByRole('combobox')).toHaveValue('bell')
  await page.keyboard.press('Escape')

  // A channel's own sound, from its menu.
  const general = page.locator('.org-row', { has: page.locator('.channel-name', { hasText: /^general$/ }) })
  await general.hover()
  await page.getByRole('button', { name: '#general options' }).click()
  await page.getByRole('menuitem', { name: /^Sound/ }).click()
  await expect(page.getByRole('menuitemradio', { name: /Server sound/ })).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: join(SHOTS, 'sounds-channel-menu.png') })
  await page.getByRole('menuitemradio', { name: 'Marimba' }).click()
  await general.hover()
  await page.getByRole('button', { name: '#general options' }).click()
  await expect(page.getByRole('menuitem', { name: /^Sound/ })).toContainText('Marimba')
})
