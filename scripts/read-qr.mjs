// Reads the QR code in an image file (PNG/JPEG) and writes its text to stdout, nothing else. Used by
// simplysign-setup.ps1 -FromClipboard / -Image, which captures the output and never shows it (it holds a TOTP seed).
// Decoding happens here, offline: zxing-wasm from client/node_modules with its local .wasm (no CDN fetch).
//
//   node scripts/read-qr.mjs <image>
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const zxing = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'node_modules', 'zxing-wasm')
const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/read-qr.mjs <image>')
  process.exit(2)
}

const { prepareZXingModule, readBarcodes } = await import(pathToFileURL(join(zxing, 'dist', 'es', 'reader', 'index.js')).href)
const wasm = readFileSync(join(zxing, 'dist', 'reader', 'zxing_reader.wasm'))
prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }, fireImmediately: true })

const image = readFileSync(file)
const results = await readBarcodes(new Blob([image]), { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 })
const found = results.find((r) => r.isValid && r.text)
if (!found) {
  console.error('No QR code found in the image.')
  process.exit(1)
}
process.stdout.write(found.text)
