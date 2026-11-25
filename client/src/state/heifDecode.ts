// Decoding a HEIC or AVIF picture on this device, to make the copy every app can show (a JPEG) and the thumbnail.
// Safari and the iPhone app decode HEIC themselves, and every current browser decodes AVIF; where the browser can't
// (HEIC in Chromium: Windows, Android, the desktop app), libheif compiled to WebAssembly does it. That decoder is
// about 2 MB, so it is only loaded the first time a HEIC is picked on such a device. Nothing leaves the device.

interface HeifImage {
  get_width(): number
  get_height(): number
  display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (result: { data: Uint8ClampedArray } | null) => void): void
  free?(): void
}

interface Libheif {
  HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] }
}

let library: Promise<Libheif> | null = null

function loadLibrary(): Promise<Libheif> {
  // @ts-expect-error libheif-js ships no types for its WebAssembly bundle.
  library ??= import('libheif-js/wasm-bundle').then((module: { default?: Libheif }) => (module.default ?? module) as Libheif)
  library.catch(() => (library = null))
  return library
}

/** The browser's own decoder: turned upright, in the picture's colours. Null if it can't read this file. */
async function decodeNatively(blob: Blob): Promise<HTMLCanvasElement | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    return canvas.width > 0 && canvas.height > 0 ? canvas : null
  } catch {
    return null
  }
}

async function decodeWithLibheif(blob: Blob): Promise<HTMLCanvasElement | null> {
  const { HeifDecoder } = await loadLibrary()
  const images = new HeifDecoder().decode(new Uint8Array(await blob.arrayBuffer()))
  const image = images[0]
  if (!image) return null
  try {
    const width = image.get_width()
    const height = image.get_height()
    if (!(width > 0) || !(height > 0)) return null
    const pixels = await new Promise<Uint8ClampedArray | null>((resolve) =>
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) => resolve(result?.data ?? null)))
    if (!pixels) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')?.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
    return canvas
  } finally {
    for (const each of images) each.free?.()
  }
}

/** The picture's pixels on a canvas (turned upright), or null if this device can't decode it either way. */
export async function decodeHeif(blob: Blob): Promise<HTMLCanvasElement | null> {
  const native = await decodeNatively(blob)
  if (native) return native
  try {
    return await decodeWithLibheif(blob)
  } catch {
    return null
  }
}
