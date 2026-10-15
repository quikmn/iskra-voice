// The server's icon and banner: from the welcome, then live from `server.images`. Admins (the `serverImages` power) set
// them in Server settings → Overview; the picture is cropped and encoded on the device, the server checks it again.
import { create } from 'zustand'
import type { FileInfo, ServerImages } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, uploadFile, useApp } from './store'

export type ServerImageKind = 'icon' | 'banner'

/** What the server takes (Features/ServerImageFeature.cs); the app crops to these shapes before uploading. */
export const SERVER_IMAGE_LIMITS = {
  icon: { maxBytes: 1024 * 1024, width: 512, height: 512, minWidth: 128, minHeight: 128 },
  banner: { maxBytes: 3 * 1024 * 1024, width: 1200, height: 450, minWidth: 480, minHeight: 120 },
} as const

interface ServerImagesState {
  /** Per server; missing until its welcome (older servers: always missing). */
  images: Record<string, ServerImages>
}

export const useServerImages = create<ServerImagesState>(() => ({ images: {} }))

/** Keeps only well-formed files (a picture's url must be a path on the server). */
export function cleanImages(raw: Partial<ServerImages> | null | undefined): ServerImages {
  const file = (f: FileInfo | null | undefined): FileInfo | null =>
    f && typeof f.url === 'string' && f.url.startsWith('/files/') ? f : null
  return { icon: file(raw?.icon), banner: file(raw?.banner) }
}

export function keepImages(serverKey: string, images: Partial<ServerImages> | null | undefined): void {
  useServerImages.setState((s) => ({ images: { ...s.images, [serverKey]: cleanImages(images) } }))
}

/** The picture's full address on its server, or null. */
export function serverImageUrl(serverUrl: string | null | undefined, file: FileInfo | null | undefined): string | null {
  if (!serverUrl || !file) return null
  return serverUrl.replace(/\/+$/, '') + file.url
}

/** The server's icon or banner address for showing it, or null (then the initials show). */
export function useServerImage(serverKey: string, kind: ServerImageKind): string | null {
  const file = useServerImages((s) => s.images[serverKey]?.[kind] ?? null)
  const url = useApp((s) => s.servers[serverKey]?.url)
  return serverImageUrl(url, file)
}

onWelcomeHook((serverKey, welcome) => {
  if (welcome.server.images) keepImages(serverKey, welcome.server.images)
})

onServerEvent((serverKey, type, body) => {
  if (type === 'server.images') keepImages(serverKey, body as ServerImages)
})

/** Uploads an already cropped picture and makes it the server's icon or banner; null removes it. */
export async function setServerImage(serverKey: string, kind: ServerImageKind, image: Blob | null, onProgress: (f: number) => void = () => {}): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error('offline')
  let id = ''
  if (image) {
    const ext = image.type === 'image/webp' ? 'webp' : image.type === 'image/jpeg' ? 'jpg' : 'png'
    const file = await uploadFile(serverKey, new File([image], `${kind}.${ext}`, { type: image.type }), onProgress)
    id = file.id
  }
  keepImages(serverKey, await connection.request('server.images.set', { [kind]: id }))
}
