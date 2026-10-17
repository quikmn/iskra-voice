// Voice message transcripts and reading aloud, all on the device. The fake mic plays someone talking (speech.wav);
// the speech model is too big for this test, so a stand-in transcriber (dev builds only) gets the recording as the
// app decoded it (16 kHz) and answers with its length. speechSynthesis is stubbed: the test reads what would be said.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { composerAction, createInviteLink, FAKE_SPEECH_ARGS, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

test.use({ launchOptions: { args: FAKE_SPEECH_ARGS } })

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Speech Test')
})
test.afterAll(async () => server?.stop())

/** Records what the app asks the speech synthesizer to say, and gives it a stand-in transcriber. */
async function speechPage(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    const w = window as unknown as { __spoken: string[]; __iskraTestTranscriber: (audio: Float32Array) => string }
    w.__spoken = []
    let speaking: SpeechSynthesisUtterance | null = null
    const fake = {
      speak(u: SpeechSynthesisUtterance) {
        w.__spoken.push(u.text)
        speaking = u
        setTimeout(() => {
          if (speaking === u) {
            speaking = null
            u.onend?.(new Event('end') as SpeechSynthesisEvent)
          }
        }, 300)
      },
      cancel() {
        speaking = null
      },
      getVoices: () => [],
      addEventListener() {},
      speaking: false,
    }
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true })
    w.__iskraTestTranscriber = (audio) => {
      let loud = 0
      for (const s of audio) if (Math.abs(s) > 0.02) loud++
      return loud > 1600 ? `I heard ${Math.round(audio.length / 16000)} seconds of talking` : ''
    }
  })
  return context.newPage()
}

const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)

test('voice message transcripts, read aloud, read new messages aloud and /tts', async ({ browser }) => {
  const host = await speechPage(browser)
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await speechPage(browser)
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── A voice message, transcribed on the listener's device.
  await composerAction(friend, 'Record a voice message')
  const bar = friend.getByRole('group', { name: 'Recording a voice message' })
  await expect(bar.locator('.voice-rec-time')).toHaveText(/^0:0[3-9]$/, { timeout: 15_000 })
  await bar.getByRole('button', { name: 'Send voice message' }).click()
  const player = host.locator('.voice-player').last()
  await expect(player.getByRole('button', { name: 'Play voice message' })).toBeEnabled()
  await player.getByRole('button', { name: 'Show transcript' }).click()
  const transcript = host.getByTestId('voice-transcript')
  await expect(transcript).toHaveText(/^I heard [3-9] seconds of talking$/)
  await expect(player.getByRole('button', { name: 'Hide transcript' })).toHaveAttribute('aria-expanded', 'true')
  await host.screenshot({ path: join(SHOTS, 'speech-transcript.png') })
  // Hidden and shown again: kept on the device, not made again.
  await host.evaluate(() => {
    (window as unknown as { __iskraTestTranscriber: () => string }).__iskraTestTranscriber = () => 'made again'
  })
  await player.getByRole('button', { name: 'Hide transcript' }).click()
  await expect(transcript).toHaveCount(0)
  await player.getByRole('button', { name: 'Show transcript' }).click()
  await expect(transcript).toHaveText(/^I heard/)
  // Still there after a reload (channel voice messages are kept in IndexedDB).
  await host.reload()
  await host.locator('.voice-player').last().getByRole('button', { name: 'Show transcript' }).click()
  await expect(host.getByTestId('voice-transcript')).toHaveText(/^I heard/)

  // ── Read aloud on a message: plain words, links as host names, code named.
  await send(friend, 'Check **this** out https://www.github.com/iskra/iskra/pull/7')
  const message = host.locator('.message', { hasText: 'Check this out' })
  await expect(message).toBeVisible()
  await message.hover()
  await message.getByRole('button', { name: 'More', exact: true }).click()
  await host.getByRole('menuitem', { name: 'Read aloud' }).click()
  await expect.poll(() => spoken(host)).toContain('Check this out link to github.com')

  // ── Read new messages aloud in #general: author and text, never your own.
  await host.locator('button.channel', { hasText: 'general' }).hover()
  await host.getByRole('button', { name: '#general options' }).click()
  await host.getByRole('menuitemradio', { name: /Read new messages aloud/ }).click()
  await host.keyboard.press('Escape')
  await expect(host.getByTestId('read-aloud-on')).toBeVisible()
  await send(friend, 'Pull up, the boss spawns in ```\nwait 5\n``` seconds')
  await expect.poll(() => spoken(host)).toContain('Friend says: Pull up, the boss spawns in code block, 1 line. seconds')
  await send(host, 'on my way')
  await expect(host.locator('.message', { hasText: 'on my way' })).toBeVisible()
  expect((await spoken(host)).some((s) => s.includes('on my way'))).toBe(false)
  // Turned off from the header.
  await host.getByTestId('read-aloud-on').click()
  await expect(host.getByTestId('read-aloud-on')).toHaveCount(0)
  await send(friend, 'nobody reads this')
  await expect(host.locator('.message', { hasText: 'nobody reads this' })).toBeVisible()
  expect((await spoken(host)).some((s) => s.includes('nobody reads this'))).toBe(false)

  // ── /tts: members need the permission (the owner has it).
  await send(friend, '/tts hello everyone')
  await expect(friend.getByRole('alert').filter({ hasText: "You can't send /tts messages on this server." })).toBeVisible()
  await expect(host.locator('.message', { hasText: 'hello everyone' })).toHaveCount(0)

  // The friend turns on "Play /tts messages" (off by default) and hears the host's.
  await openSettings(friend, 'Voice & audio')
  const play = friend.getByRole('checkbox', { name: 'Play /tts messages' })
  await expect(play).not.toBeChecked()
  await play.check()
  await friend.getByRole('dialog', { name: 'Settings' }).getByRole('heading', { name: 'Speech' }).scrollIntoViewIfNeeded()
  await friend.screenshot({ path: join(SHOTS, 'speech-settings.png') })
  await friend.keyboard.press('Escape')
  await send(host, '/tts GG everyone')
  await expect(friend.locator('.message', { hasText: 'GG everyone' })).toBeVisible()
  await expect.poll(() => spoken(friend)).toContain('Host says: GG everyone')
  // The host doesn't hear their own.
  expect((await spoken(host)).some((s) => s.includes('GG everyone'))).toBe(false)

  // ── Phone width: the transcript fits under the player.
  await host.setViewportSize({ width: 390, height: 800 })
  await host.reload()
  const phonePlayer = host.locator('.voice-player').last()
  await phonePlayer.scrollIntoViewIfNeeded()
  await phonePlayer.getByRole('button', { name: 'Show transcript' }).click()
  const box = await host.getByTestId('voice-transcript').boundingBox()
  expect(box && box.x + box.width).toBeLessThanOrEqual(390)
  await host.screenshot({ path: join(SHOTS, 'speech-transcript-phone.png') })
})
