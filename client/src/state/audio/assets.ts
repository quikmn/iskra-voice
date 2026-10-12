// The voice models and engines, bundled with the app (no CDN) and fetched from the app's own origin on first use:
// DeepFilterNet3 (~16 MB WebAssembly + ~8 MB model, about 12 MB over gzip), Silero VAD (~1.3 MB) and RNNoise.
// Each is fetched once per session and kept.
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import dfWasmUrl from '../../../vendor/deepfilternet/deepfilter.wasm?url'
// The model is DeepFilterNet3_onnx.tar.gz, named .bin so web servers don't send it gzip-encoded (browsers would unpack it).
import dfModelUrl from '../../../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz.bin?url'
import sileroUrl from '../../../vendor/silero-vad/silero_vad_16k_op15.onnx?url'

export interface DeepFilterAssets {
  /** The engine, compiled (workers take it as is). */
  module: WebAssembly.Module
  /** The engine's bytes (audio worklets compile their own copy: not every browser can send them a module). */
  wasm: ArrayBuffer
  /** DeepFilterNet3_onnx.tar.gz. */
  model: ArrayBuffer
}

async function bytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.arrayBuffer()
}

/** In case a web server sent the model gzip-encoded anyway and the browser unpacked it: pack it again. */
async function gzipped(data: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(data, 0, 2)
  if (head[0] === 0x1f && head[1] === 0x8b) return data
  if (typeof CompressionStream !== 'function') throw new Error('model arrived unpacked')
  return new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
}

let deepFilter: Promise<DeepFilterAssets> | null = null
export function loadDeepFilter(): Promise<DeepFilterAssets> {
  deepFilter ??= (async () => {
    const [wasm, model] = await Promise.all([bytes(dfWasmUrl), bytes(dfModelUrl).then(gzipped)])
    return { wasm, model, module: await WebAssembly.compile(wasm) }
  })()
  deepFilter.catch(() => (deepFilter = null))
  return deepFilter
}

let silero: Promise<ArrayBuffer> | null = null
export function loadSilero(): Promise<ArrayBuffer> {
  silero ??= bytes(sileroUrl)
  silero.catch(() => (silero = null))
  return silero
}

let rnnoise: Promise<ArrayBuffer> | null = null
export function loadRnnoiseWasm(): Promise<ArrayBuffer> {
  rnnoise ??= import('@sapphi-red/web-noise-suppressor').then((lib) => lib.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }))
  rnnoise.catch(() => (rnnoise = null))
  return rnnoise
}
