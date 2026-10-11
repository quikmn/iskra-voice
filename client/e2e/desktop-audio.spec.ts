// Windows: sharing your computer's sound must not send the call back to the people in it.
// Iskra plays one quiet tone (like a friend's voice), another app plays a second one; the shared system audio
// must carry the other app's tone and not Iskra's.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const ELECTRON = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test.skip(process.platform !== 'win32', 'system audio sharing is Windows-only')
test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')

test("shared system audio leaves out Iskra's own sound", async () => {
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({ executablePath: ELECTRON, args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', '--autoplay-policy=no-user-gesture-required'], cwd: DESKTOP, env })
  let other: ChildProcess | null = null
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Sharer')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible() // past onboarding: the screen picker is mounted
    other = spawn(ELECTRON, [join(HERE, 'fixtures', 'tone')], { env, stdio: 'ignore' })

    const measured = page.evaluate(async () => {
      const OWN = 3001
      const OTHER = 4003
      // Iskra's own playback, standing in for the call.
      const own = new AudioContext()
      const osc = own.createOscillator()
      const gain = own.createGain()
      gain.gain.value = 0.003
      osc.frequency.value = OWN
      osc.connect(gain).connect(own.destination)
      osc.start()
      // The same audio constraints the share menu uses (state/screenShare.ts).
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints,
      })
      const track = stream.getAudioTracks()[0]
      if (!track) return null
      const ctx = new AudioContext({ sampleRate: 48000 })
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 32768
      ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser)
      const bins = new Float32Array(analyser.frequencyBinCount)
      const hz = 48000 / analyser.fftSize
      // How far a tone stands above the noise around it, in dB.
      const strength = (f: number) => {
        const b = Math.round(f / hz)
        const peak = Math.max(...bins.slice(b - 2, b + 3))
        const around = [...bins.slice(b - 60, b - 10), ...bins.slice(b + 10, b + 60)].sort((x, y) => x - y)
        return peak - around[around.length >> 1]
      }
      await new Promise((r) => setTimeout(r, 2500))
      let ownDb = -99
      let otherDb = -99
      for (let i = 0; i < 20; i++) {
        analyser.getFloatFrequencyData(bins)
        ownDb = Math.max(ownDb, strength(OWN))
        otherDb = Math.max(otherDb, strength(OTHER))
        await new Promise((r) => setTimeout(r, 100))
      }
      stream.getTracks().forEach((t) => t.stop())
      void own.close()
      void ctx.close()
      return { ownDb, otherDb }
    })
    // Iskra's own screen picker: pick the first screen.
    await page.locator('.source').first().click()
    const result = await measured
    console.log('shared system audio:', result)
    expect(result).not.toBeNull()
    expect(result!.otherDb).toBeGreaterThan(40) // other apps' sound is shared...
    expect(result!.ownDb).toBeLessThan(30) // ...and Iskra's isn't
  } finally {
    other?.kill()
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
