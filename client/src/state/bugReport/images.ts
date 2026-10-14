// Screenshots for bug reports: decoded and drawn again on a canvas, which drops EXIF and anything else hidden in the
// file, then encoded small enough (at most MAX_IMAGE_BYTES each), shrinking step by step if needed.
import { MAX_IMAGE_BYTES, type ImageType, type ReportImage } from './payload'

export const MAX_SIDE = 2560

/** Width and height scaled to fit `max` on the longer side (never enlarged). */
export function fitSize(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The encodings to try, in order: lossless first (sharp text), then smaller and smaller. */
export function encodePlan(width: number, height: number): { type: ImageType; quality?: number; width: number; height: number }[] {
  const plan: { type: ImageType; quality?: number; width: number; height: number }[] = []
  let size = fitSize(width, height)
  plan.push({ type: 'image/png', ...size })
  for (let i = 0; i < 4; i++) {
    plan.push({ type: 'image/webp', quality: 0.85, ...size }, { type: 'image/jpeg', quality: 0.8, ...size })
    size = fitSize(size.width, size.height, Math.round(Math.max(size.width, size.height) * 0.7))
  }
  return plan
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Any image the browser can decode, as a clean screenshot; throws if it isn't one. */
export async function prepareImage(source: Blob): Promise<ReportImage> {
  const bitmap = await createImageBitmap(source)
  try {
    for (const step of encodePlan(bitmap.width, bitmap.height)) {
      const canvas = document.createElement('canvas')
      canvas.width = step.width
      canvas.height = step.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No canvas')
      context.drawImage(bitmap, 0, 0, step.width, step.height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, step.type, step.quality))
      // A browser that can't write WebP gives PNG instead: the type must be what the bytes are.
      if (!blob || blob.type !== step.type || blob.size > MAX_IMAGE_BYTES) continue
      return { type: step.type, data: await toBase64(blob), bytes: blob.size, width: step.width, height: step.height }
    }
  } finally {
    bitmap.close()
  }
  throw new Error('Image too big')
}
