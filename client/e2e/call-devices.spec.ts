// Choosing the microphone and the speaker from the call's own buttons (the arrow next to mic and deafen): a menu on
// desktop, a sheet on a phone, the Android app's own list of where a call plays; and a microphone problem in a call
// with its two ways out. Chromium's fake devices only ("Fake Audio Input 1", ...).
import { join } from 'node:path'
import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { hasLiveKit, joinVia, longPress, SHOTS, startServer, VOICE_JOIN, type TestServer } from './helpers'

const { defaultBrowserType: _b, ...pixel } = devices['Pixel 7']

type Probe = { micAsks: string[]; lastMic: MediaStreamTrack | null }

/** Records which microphone each capture asked for (by id; '' for none) and keeps the newest live track. */
function watchMics() {
  const md = navigator.mediaDevices
  const real = md.getUserMedia.bind(md)
  const w = window as unknown as Probe
  w.micAsks = []
  w.lastMic = null
  md.getUserMedia = async (constraints) => {
    const stream = await real(constraints)
    const track = stream.getAudioTracks()[0]
    if (track) {
      const audio = (typeof constraints?.audio === 'object' ? constraints.audio : {}) as { deviceId?: { exact?: string } | string }
      w.micAsks.push(typeof audio.deviceId === 'string' ? audio.deviceId : (audio.deviceId?.exact ?? ''))
      w.lastMic = track
    }
    return stream
  }
}

const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('iskra.audio') ?? '{}') as { inputDevice?: string; outputDevice?: string })
const deviceId = (page: Page, kind: string, label: string) =>
  page.evaluate(async ([k, l]) => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === k && d.label === l)?.deviceId ?? '', [kind, label])
/** The microphone the call is capturing right now. */
const micInUse = (page: Page) =>
  page.evaluate(() => {
    const track = (window as unknown as Probe).lastMic
    return track?.readyState === 'live' ? (track.getSettings().deviceId ?? '') : ''
  })

async function voiceChannel(page: Page, phone = false) {
  if (phone) await page.getByRole('button', { name: 'Open channels' }).click()
  await page.getByRole('button', { name: 'Create voice channel' }).click()
  await page.getByRole('radio', { name: 'Voice' }).click()
  await page.getByLabel('Name').fill('talk')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByTitle('Join talk').click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
}

test.describe('devices from the call controls', () => {
  test.skip(!hasLiveKit(), 'needs LiveKit in .tools')
  // A server per test: each one joins as its owner (the owner link works once).
  let server: TestServer
  let contexts: BrowserContext[] = []
  test.beforeEach(async () => {
    server = await startServer('Call devices', true)
  })
  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)))
    contexts = []
    await server?.stop()
  })
  const open = async (browser: import('@playwright/test').Browser, options: Parameters<typeof browser.newContext>[0], init: () => void) => {
    const context = await browser.newContext(options)
    contexts.push(context)
    await context.addInitScript(init)
    return context.newPage()
  }

  test('desktop: the arrows list the devices, picking one switches the running call and is remembered', async ({ browser }) => {
    const page = await open(browser, {}, watchMics)
    await joinVia(page, server.ownerLink(), 'Host')
    await voiceChannel(page)
    await expect.poll(() => micInUse(page), { timeout: 15_000 }).not.toBe('')
    const second = await deviceId(page, 'audioinput', 'Fake Audio Input 2')
    expect(second).not.toBe('')
    expect(await micInUse(page)).not.toBe(second)

    // The voice bar's arrow next to the mic: the real microphones, the default marked.
    const bar = page.locator('.voice-bar')
    await bar.getByRole('button', { name: 'Choose a microphone' }).click()
    const mics = page.getByRole('dialog', { name: 'Choose a microphone' })
    await expect(mics.getByRole('menuitemradio')).toHaveText(['System default', 'Fake Audio Input 1', 'Fake Audio Input 2'])
    await expect(mics.getByRole('menuitemradio', { name: 'System default' })).toHaveAttribute('aria-checked', 'true')
    await expect(mics).toHaveClass(/org-menu/)
    await page.screenshot({ path: join(SHOTS, 'call-devices-voice-bar-menu.png') })

    // Picking one: the call captures that microphone (no rejoin), and it is the setting from now on.
    const asksBefore = await page.evaluate(() => (window as unknown as Probe).micAsks.length)
    await mics.getByRole('menuitemradio', { name: 'Fake Audio Input 2' }).click()
    await expect(mics).toHaveCount(0)
    await expect.poll(() => micInUse(page)).toBe(second)
    expect((await saved(page)).inputDevice).toBe(second)
    expect(await page.evaluate(() => (window as unknown as Probe).micAsks.at(-1))).toBe(second)
    expect(await page.evaluate(() => (window as unknown as Probe).micAsks.length)).toBeGreaterThan(asksBefore)
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected')
    await expect(page.getByTestId('voice-error')).toHaveCount(0)

    // The call screen's own arrow shows the same list, now with that one marked.
    const controls = page.locator('.call-controls')
    await controls.getByRole('button', { name: 'Choose a microphone' }).click()
    await expect(mics.getByRole('menuitemradio', { name: 'Fake Audio Input 2' })).toHaveAttribute('aria-checked', 'true')
    await expect(mics.getByRole('menuitemradio', { name: 'System default' })).toHaveAttribute('aria-checked', 'false')
    await page.screenshot({ path: join(SHOTS, 'call-devices-call-menu.png') })
    await page.keyboard.press('Escape')
    await expect(mics).toHaveCount(0)

    // Deafen carries the speakers.
    await controls.getByRole('button', { name: 'Choose where sound plays' }).click()
    const speakers = page.getByRole('dialog', { name: 'Choose where sound plays' })
    await expect(speakers.getByRole('menuitemradio').first()).toHaveText('System default')
    const output = speakers.getByRole('menuitemradio').nth(1)
    const outputName = (await output.textContent())!
    await output.click()
    await expect.poll(async () => (await saved(page)).outputDevice).toBe(await deviceId(page, 'audiooutput', outputName))
    await bar.getByRole('button', { name: 'Choose where sound plays' }).click()
    await expect(speakers.getByRole('menuitemradio', { name: outputName })).toHaveAttribute('aria-checked', 'true')

    // The link to the settings page.
    await speakers.getByRole('menuitem', { name: 'Voice & audio settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('heading', { name: 'Noise suppression' })).toBeVisible()
  })

  test('phone: the arrow on the mic button opens a sheet, and so does holding the button', async ({ browser }) => {
    const page = await open(browser, { ...pixel, permissions: ['microphone'] }, watchMics)
    await joinVia(page, server.ownerLink(), 'Phone')
    await voiceChannel(page, true)
    await expect(page.locator('.stage')).toBeVisible()
    await expect.poll(() => micInUse(page), { timeout: 15_000 }).not.toBe('')
    const first = await deviceId(page, 'audioinput', 'Fake Audio Input 1')

    const controls = page.locator('.call-controls.phone')
    await controls.getByRole('button', { name: 'Choose a microphone' }).click()
    const sheet = page.getByRole('dialog', { name: 'Choose a microphone' })
    await expect(sheet).toHaveClass(/action-sheet/)
    await expect(sheet.getByRole('menuitemradio')).toHaveText(['System default', 'Fake Audio Input 1', 'Fake Audio Input 2'])
    // A sheet from the bottom edge, every row a finger high.
    const box = (await sheet.boundingBox())!
    expect(Math.round(box.y + box.height)).toBe(page.viewportSize()!.height)
    for (const row of await sheet.getByRole('menuitemradio').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: join(SHOTS, 'call-devices-phone-sheet.png') })
    await sheet.getByRole('menuitemradio', { name: 'Fake Audio Input 1' }).click()
    await expect(sheet).toHaveCount(0)
    await expect.poll(() => micInUse(page)).toBe(first)
    expect((await saved(page)).inputDevice).toBe(first)

    // Holding the mic button: the same sheet, and the hold doesn't mute.
    await longPress(page, controls.getByRole('button', { name: 'Mute', exact: true }))
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('menuitemradio', { name: 'Fake Audio Input 1' })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(controls.getByRole('button', { name: 'Mute', exact: true })).toBeVisible()

    // The voice panel in the channel drawer has the same arrows.
    await page.getByRole('button', { name: 'Open channels' }).click()
    const bar = page.locator('.voice-bar')
    await expect(bar.getByRole('button', { name: 'Leave voice' })).toBeInViewport({ ratio: 1 })
    // With the two arrows the row still fits its card: nothing is pushed out past the edge.
    const card = (await bar.boundingBox())!
    for (const button of await bar.locator('.voice-controls button').all()) {
      const b = (await button.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(card.x)
      expect(b.x + b.width).toBeLessThanOrEqual(card.x + card.width)
    }
    await page.screenshot({ path: join(SHOTS, 'call-devices-phone-drawer.png') })
    await bar.getByRole('button', { name: 'Choose a microphone' }).click()
    await expect(sheet).toHaveClass(/action-sheet/)
    await page.screenshot({ path: join(SHOTS, 'call-devices-phone-drawer-sheet.png') })
  })

  test('a microphone that will not open: the error has "Choose microphone" and "Report a bug", and the buttons stay in reach', async ({ browser }) => {
    const page = await open(browser, { ...pixel, permissions: ['microphone'] }, () => {
      // The default microphone can't be opened (as Android's web view answers); one asked for by its id can.
      const md = navigator.mediaDevices
      const real = md.getUserMedia.bind(md)
      const w = window as unknown as { lastMic: MediaStreamTrack | null }
      w.lastMic = null
      md.getUserMedia = async (constraints) => {
        const audio = (typeof constraints?.audio === 'object' ? constraints.audio : {}) as { deviceId?: { exact?: string } }
        if (constraints?.audio && !audio.deviceId?.exact) throw new DOMException('Could not start audio source', 'NotReadableError')
        const stream = await real(constraints)
        w.lastMic = stream.getAudioTracks()[0] ?? w.lastMic
        return stream
      }
    })
    await joinVia(page, server.ownerLink(), 'Phone')
    await voiceChannel(page, true)
    await expect(page.locator('.stage')).toBeVisible()

    const error = page.locator('.stage').getByTestId('voice-error')
    await expect(error).toContainText("Couldn't open your microphone. Another app may be using it.")
    await expect(error.getByRole('button', { name: 'Choose microphone' })).toBeVisible()
    await expect(error.getByRole('button', { name: 'Report a bug' })).toBeVisible()
    // The error has its own row: every call button is on screen and nothing lies over it.
    const controls = page.locator('.call-controls.phone')
    const errorBox = (await error.boundingBox())!
    for (const name of ['Unmute', 'Turn camera on', 'More', 'Leave call']) {
      const button = controls.getByRole('button', { name, exact: true })
      await expect(button).toBeInViewport({ ratio: 1 })
      const b = (await button.boundingBox())!
      expect(b.y).toBeGreaterThanOrEqual(errorBox.y + errorBox.height)
      expect(await button.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
      })).toBe(true)
    }
    await page.screenshot({ path: join(SHOTS, 'call-devices-error-phone.png') })

    // "Report a bug" opens the report (a dialog on a phone), with the call still there.
    await error.getByRole('button', { name: 'Report a bug' }).click()
    const report = page.getByRole('dialog', { name: 'Report a bug' })
    await expect(report).toBeVisible()
    await report.getByRole('button', { name: 'Close' }).first().click()
    await expect(report).toHaveCount(0)

    // "Choose microphone" opens the same sheet; a microphone that works puts the mic on and the error away.
    await error.getByRole('button', { name: 'Choose microphone' }).click()
    const sheet = page.getByRole('dialog', { name: 'Choose a microphone' })
    await expect(sheet).toHaveClass(/action-sheet/)
    await sheet.getByRole('menuitemradio', { name: 'Fake Audio Input 2' }).click()
    await expect(error).toHaveCount(0)
    await expect(controls.getByRole('button', { name: 'Mute', exact: true })).toBeVisible()
    const second = await deviceId(page, 'audioinput', 'Fake Audio Input 2')
    await expect.poll(() => page.evaluate(() => (window as unknown as { lastMic: MediaStreamTrack | null }).lastMic?.getSettings().deviceId ?? '')).toBe(second)
  })

  test('no microphone at all: "Choose microphone" opens Voice & audio in the settings', async ({ browser }) => {
    const page = await open(browser, {}, () => {
      const md = navigator.mediaDevices
      if (!md) return // about:blank
      md.getUserMedia = async () => {
        throw new DOMException('Requested device not found', 'NotFoundError')
      }
      md.enumerateDevices = async () => []
    })
    await joinVia(page, server.ownerLink(), 'Host')
    await voiceChannel(page)
    const error = page.locator('.stage').getByTestId('voice-error')
    await expect(error).toContainText('No microphone found.')
    // Shown once: the call screen has it, so the voice bar next to it doesn't repeat it.
    await expect(page.getByTestId('voice-error')).toHaveCount(1)
    // Nothing to choose from: no arrows.
    await expect(page.getByRole('button', { name: 'Choose a microphone' })).toHaveCount(0)
    await page.screenshot({ path: join(SHOTS, 'call-devices-error-desktop.png') })
    await error.getByRole('button', { name: 'Choose microphone' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('heading', { name: 'Noise suppression' })).toBeVisible()
  })

  test('the Android app: the speaker button lists where the call can play, and picking one routes it there', async ({ browser }) => {
    type Shell = { routeCalls: number[]; speakerCalls: boolean[]; plugHeadset: () => void }
    const page = await open(browser, { ...pixel, permissions: ['microphone'] }, () => {
      // A stand-in for Capacitor's bridge and the app's plugin (mobile/android/.../IskraNativePlugin.java).
      const routes = [{ id: 3, kind: 'speaker', name: 'Pixel 7' }, { id: 2, kind: 'earpiece', name: 'Pixel 7' }]
      let current = 3
      const listeners: Record<string, (data: unknown) => void> = {}
      const shell: Shell = {
        routeCalls: [],
        speakerCalls: [],
        plugHeadset: () => {
          routes.push({ id: 9, kind: 'bluetooth', name: 'Buds Pro' })
          current = 9
          listeners.voiceRoute?.({ headset: true })
        },
      }
      const headset = () => routes.some((r) => r.kind === 'bluetooth')
      const plugin: Record<string, (options: { on?: boolean; id?: number }) => unknown> = {
        voiceStart: () => undefined, voiceUpdate: () => undefined, voiceStop: () => undefined, keepAwake: () => undefined,
        takeShare: () => ({}), shareDone: () => undefined,
        voiceSpeaker: ({ on }) => {
          shell.speakerCalls.push(!!on)
          if (!headset()) current = on ? 3 : 2
          return { headset: headset() }
        },
        voiceRoutes: () => ({ routes, current }),
        voiceRoute: ({ id }) => {
          shell.routeCalls.push(id!)
          current = id!
          return { routes, current }
        },
      }
      const w = window as unknown as Record<string, unknown>
      w.androidShell = shell
      w.androidBridge = {}
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        PluginHeaders: [{ name: 'IskraNative', methods: [...Object.keys(plugin).map((name) => ({ name, rtype: 'promise' })), { name: 'addListener' }, { name: 'removeListener' }] }],
        nativePromise: async (_plugin: string, method: string, options: object) => plugin[method](options ?? {}),
        nativeCallback: (_plugin: string, method: string, options: { eventName: string }, callback: (data: unknown) => void) => {
          if (method === 'addListener') listeners[options.eventName] = callback
          return options.eventName
        },
      }
    })
    const shell = <T>(read: (s: Shell) => T) => page.evaluate((f) => (new Function('s', `return (${f})(s)`) as (s: Shell) => T)((window as unknown as { androidShell: Shell }).androidShell), read.toString())
    await joinVia(page, server.ownerLink(), 'Phone')
    await voiceChannel(page, true)
    await expect(page.locator('.stage')).toBeVisible()

    // No headset: the speaker button, with its arrow. The list is the phone's own two ways to play.
    const controls = page.locator('.call-controls.phone')
    const speaker = controls.getByTestId('speaker-button')
    await expect(speaker).toHaveAttribute('aria-pressed', 'true')
    await controls.getByRole('button', { name: 'Choose where sound plays' }).click()
    const sheet = page.getByRole('dialog', { name: 'Choose where sound plays' })
    await expect(sheet.getByRole('menuitemradio')).toHaveText(['Speaker', 'Phone'])
    await expect(sheet.getByRole('menuitemradio', { name: 'Speaker' })).toHaveAttribute('aria-checked', 'true')
    await sheet.getByRole('menuitemradio', { name: 'Phone' }).click()
    await expect(sheet).toHaveCount(0)
    await expect.poll(() => shell((s) => s.routeCalls)).toEqual([2])
    // The button follows the list.
    await expect(speaker).toHaveAttribute('aria-pressed', 'false')

    // A Bluetooth headset connects: deafen takes the speaker button's place, and its arrow lists the headset by name.
    await shell((s) => s.plugHeadset())
    await expect(speaker).toHaveCount(0)
    await controls.getByRole('button', { name: 'Choose where sound plays' }).click()
    await expect(sheet.getByRole('menuitemradio')).toHaveText(['Speaker', 'Phone', 'Buds Pro'])
    await expect(sheet.getByRole('menuitemradio', { name: 'Buds Pro' })).toHaveAttribute('aria-checked', 'true')
    await page.screenshot({ path: join(SHOTS, 'call-devices-android-outputs.png') })
    await sheet.getByRole('menuitemradio', { name: 'Speaker' }).click()
    await expect.poll(() => shell((s) => s.routeCalls)).toEqual([2, 3])
    await controls.getByRole('button', { name: 'Choose where sound plays' }).click()
    await expect(sheet.getByRole('menuitemradio', { name: 'Speaker' })).toHaveAttribute('aria-checked', 'true')
  })
})
