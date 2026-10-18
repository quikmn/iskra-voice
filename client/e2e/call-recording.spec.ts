// Recording a voice channel: the recorder's app (the desktop app, here a stand-in bridge that keeps the files in the
// page) records each person to their own file; everyone sees the mark, joins muted with a notice, and can say
// "don't record me". Chromium's fake microphone is the only audio.
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Recording Test', true)
})
test.afterAll(async () => server?.stop())

const studio = (page: Page) => page.locator('.voice-channel', { hasText: 'studio' })

type Files = Record<string, { size: number; head: number[]; closed: boolean }>
const files = (page: Page) => page.evaluate(() => (window as unknown as { __rec: { files: Files } }).__rec.files)
const recorded = (page: Page) => page.evaluate(() => (window as unknown as { __rec: { info: string; ended: boolean; shown: number } }).__rec)

test('recording a call: per-person files on the recorder, a mark for everyone, muted joins and "don\'t record me"', async ({ browser }) => {
  test.setTimeout(180_000)
  const hostContext = await browser.newContext()
  // The desktop app's bridge, as far as this test needs it: recordings land in the page.
  await hostContext.addInitScript(() => {
    const files: Record<string, { size: number; head: number[]; closed: boolean }> = {}
    const names: Record<string, string> = {}
    let n = 0
    const rec = { files, info: '', ended: false, shown: 0 }
    ;(window as unknown as { __rec: typeof rec }).__rec = rec
    ;(window as unknown as { iskraDesktop: unknown }).iskraDesktop = {
      platform: 'win32',
      setPushToTalkKey: async () => undefined,
      capturePushToTalkKey: async () => null,
      onPushToTalk: () => () => undefined,
      pushToTalkStatus: async () => 'ready',
      openSystemSettings: async () => undefined,
      updates: { status: async () => ({ state: 'idle' }), onStatus: () => () => undefined, restart: async () => false },
      onPickScreen: () => () => undefined,
      pickScreen: () => undefined,
      host: { available: async () => false, list: async () => [], templates: async () => [], onP2p: () => () => undefined },
      recordings: {
        folder: async () => 'C:\\Users\\Test\\Documents\\Iskra recordings',
        pickFolder: async () => null,
        begin: async (srv: string, channel: string) => ({ id: 'r1', folder: `C:\\Users\\Test\\Documents\\Iskra recordings\\${srv}\\${channel}\\now` }),
        open: async (_id: string, name: string) => {
          const id = `f${++n}`
          names[id] = name
          files[name] = { size: 0, head: [], closed: false }
          return id
        },
        write: async (id: string, data: Uint8Array) => {
          const file = files[names[id]]
          if (!file || file.closed) return 'failed'
          if (file.size === 0) file.head = [...data.slice(0, 4)]
          file.size += data.length
          return 'ok'
        },
        close: async (id: string) => {
          files[names[id]].closed = true
          return true
        },
        info: async (_id: string, text: string) => {
          rec.info = text
          return true
        },
        end: async () => {
          rec.ended = true
        },
        show: async () => {
          rec.shown++
        },
      },
    }
  })
  const host = await hostContext.newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('studio')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(studio(host)).toBeVisible()

  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  for (const page of [host, friend]) {
    await studio(page).getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
  }
  // Members can't record by default: no button.
  await expect(friend.locator('.call-controls').getByRole('button', { name: 'Record this call' })).toHaveCount(0)
  await expect
    .poll(() => host.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)), { timeout: 15_000 })
    .toBe(true)

  // The host starts recording: the dialog says what happens and where the files go.
  await host.locator('.call-controls').getByRole('button', { name: 'Record this call' }).click()
  const dialog = host.getByRole('dialog', { name: 'Record this call' })
  await expect(dialog.getByText('C:\\Users\\Test\\Documents\\Iskra recordings')).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Also save one file with everyone mixed together' })).toBeChecked()
  await host.waitForTimeout(300) // the dialog has faded in
  await host.screenshot({ path: join(SHOTS, 'recording-dialog.png') })
  await dialog.getByRole('button', { name: 'Start recording' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(host.getByTestId('recording-strip')).toContainText("You're recording")

  // Everyone sees it: the strip, a notice with a sound, the channel's REC mark and the recorder's mark.
  await expect(friend.getByTestId('recording-strip')).toContainText('Recording by Host')
  await expect(friend.getByTestId('recording-notice')).toContainText('Host started recording this call.')
  await friend.waitForTimeout(300) // the notice has slid in
  await expect(studio(friend).getByRole('img', { name: 'This call is being recorded' })).toBeVisible()
  await expect(studio(friend).locator('li', { hasText: 'Host' }).getByRole('img', { name: 'Recording' })).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'recording-started.png') })
  await friend.getByTestId('recording-notice').getByRole('button', { name: 'OK' }).click()
  await expect(friend.getByTestId('recording-notice')).toHaveCount(0)

  // A file each (and the mix), filling up.
  await expect.poll(async () => {
    const f = await files(host)
    return ['Host.webm', 'Friend.webm', 'mixed.webm'].every((name) => (f[name]?.size ?? 0) > 0)
  }, { timeout: 15_000 }).toBe(true)

  // The friend leaves and comes back: they join muted, told before they can speak.
  await friend.getByRole('button', { name: 'Leave voice' }).click()
  await expect.poll(async () => (await files(host))['Friend.webm']?.closed, { timeout: 10_000 }).toBe(true)
  await studio(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
  const notice = friend.getByTestId('recording-notice')
  await expect(notice).toContainText('Host is recording this call. You joined muted')
  await expect(friend.locator('.voice-bar').getByRole('button', { name: 'Unmute' })).toBeVisible()
  await friend.setViewportSize({ width: 390, height: 844 })
  await expect(notice).toBeInViewport()
  await friend.waitForTimeout(500) // the panels settle at phone width
  await friend.screenshot({ path: join(SHOTS, 'recording-joined-phone.png') })
  await friend.setViewportSize({ width: 1280, height: 720 })
  await expect.poll(async () => (await files(host))['Friend (2).webm']?.size ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)

  // "Don't record me": the recorder's app ends their file, and everyone sees they're left out.
  await notice.getByRole('button', { name: "Don't record me" }).click()
  await expect(notice).toContainText("You're left out of the recording.")
  await notice.getByRole('button', { name: 'OK, unmute' }).click()
  await expect(friend.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })).toBeVisible()
  await expect(studio(host).locator('li', { hasText: 'Friend' }).getByRole('img', { name: 'Not in the recording' })).toBeVisible()
  await expect.poll(async () => (await files(host))['Friend (2).webm']?.closed, { timeout: 10_000 }).toBe(true)
  await expect(friend.getByTestId('recording-strip')).toContainText("You're not in the recording")
  await expect(friend.getByTestId('recording-strip').getByRole('button', { name: 'Record me again' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'recording-host.png') })

  // The host stops: the mark goes for everyone, the files are finished, info.txt says who and when.
  await host.locator('.call-controls').getByRole('button', { name: 'Stop recording' }).click()
  await expect(friend.getByTestId('recording-strip')).toHaveCount(0)
  await expect(studio(friend).getByRole('img', { name: 'This call is being recorded' })).toHaveCount(0)
  const saved = host.getByRole('status').filter({ hasText: 'Recording saved.' })
  await expect(saved).toBeVisible()
  await saved.getByRole('button', { name: 'Open folder' }).click()
  const done = await recorded(host)
  expect(done.ended).toBe(true)
  expect(done.shown).toBe(1)
  const all = await files(host)
  expect(Object.keys(all).sort()).toEqual(['Friend (2).webm', 'Friend.webm', 'Host.webm', 'mixed.webm'])
  for (const [name, file] of Object.entries(all)) {
    expect(file.closed, name).toBe(true)
    expect(file.head, name).toEqual([0x1a, 0x45, 0xdf, 0xa3]) // WebM
  }
  expect(done.info).toContain('Channel: studio')
  expect(done.info).toContain('Recorded by: Host')
  expect(done.info).toMatch(/Friend \(2\)\.webm: from 0:\d\d:\d\d to 0:\d\d:\d\d/)
  expect(done.info).toContain('mixed.webm: everyone together')

  // The channel's chat says it too (older apps see the same line as text).
  await friend.getByRole('button', { name: /Open chat/ }).click()
  const chat = friend.getByRole('region', { name: 'Chat in studio' })
  await expect(chat.locator('.record-notice', { hasText: 'Host started recording this call' })).toBeVisible()
  await expect(chat.locator('.record-notice', { hasText: 'Host stopped recording this call' })).toBeVisible()

  // "Don't record me" is kept by the server for the account: a fresh page shows it.
  await friend.reload()
  await studio(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
  await expect(studio(host).locator('li', { hasText: 'Friend' }).getByRole('img', { name: 'Not in the recording' })).toHaveCount(0) // nothing recorded now
  await host.locator('.call-controls').getByRole('button', { name: 'Record this call' }).click()
  await host.getByRole('dialog', { name: 'Record this call' }).getByRole('button', { name: 'Start recording' }).click()
  await expect(studio(host).locator('li', { hasText: 'Friend' }).getByRole('img', { name: 'Not in the recording' })).toBeVisible()
  await expect(friend.getByTestId('recording-strip').getByRole('button', { name: 'Record me again' })).toBeVisible()
})
