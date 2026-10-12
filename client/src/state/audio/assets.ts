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
  /** The engine, compiled once per page (off the main thread, and from the browser's code cache after the first time). */
  module: WebAssembly.Module
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

/** Compiles the engine while it downloads where the browser can (and then caches the compiled code). */
async function compileDeepFilter(): Promise<WebAssembly.Module> {
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(fetch(dfWasmUrl))
    } catch {
      /* served without the WebAssembly type: compile the bytes instead */
    }
  }
  return WebAssembly.compile(await deepFilterBytes())
}

let deepFilter: Promise<DeepFilterAssets> | null = null
export function loadDeepFilter(): Promise<DeepFilterAssets> {
  deepFilter ??= (async () => {
    const [module, model] = await Promise.all([compileDeepFilter(), bytes(dfModelUrl).then(gzipped)])
    return { module, model }
  })()
  deepFilter.catch(() => (deepFilter = null))
  return deepFilter
}

let dfBytes: Promise<ArrayBuffer> | null = null
/** The engine's bytes, for an audio worklet that can't be handed a compiled module (it compiles its own). */
export function deepFilterBytes(): Promise<ArrayBuffer> {
  dfBytes ??= bytes(dfWasmUrl)
  dfBytes.catch(() => (dfBytes = null))
  return dfBytes
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
