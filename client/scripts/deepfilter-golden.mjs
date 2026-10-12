// Writes the golden-test inputs for DeepFilterNet (6 s of the speech fixture, clean and with fan and keyboard noise)
// to <dir>. The references in vendor/deepfilternet/golden/ are what DeepFilterNet's official command line tool made
// of them: deep-filter 0.5.6 (github.com/Rikorose/DeepFilterNet/releases/tag/v0.5.6) with its defaults,
//   deep-filter-0.5.6-x86_64-pc-windows-msvc.exe -o out <dir>/clean.wav <dir>/noisy.wav
// and the outputs copied to vendor/deepfilternet/golden/. quality.test.ts checks our build against them.
// Run from client/: node scripts/deepfilter-golden.mjs <dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'

const dir = process.argv[2]
if (!dir) throw new Error('usage: node scripts/deepfilter-golden.mjs <dir>')
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const q = await vite.ssrLoadModule('/src/state/audio/quality.ts')
  const b = readFileSync(new URL('../e2e/fixtures/speech.wav', import.meta.url))
  const fixture = q.readWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  const { clean, noisy } = q.goldenInputs(q.upsample(fixture.pcm, q.RATE / fixture.rate))
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/clean.wav`, q.wavBytes(clean))
  writeFileSync(`${dir}/noisy.wav`, q.wavBytes(noisy))
} finally {
  await vite.close()
}
