// Server stickers: the list per server (kept fresh by stickers.updated), sending one, and managing them (admins).
import { create } from 'zustand'
import { t } from '../i18n'
import type { Events, Sticker } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, sendMessage, uploadFile, type SendOptions } from './store'

export const MAX_STICKERS = 60
const MAX_SIDE = 320
/** Still images bigger than this are re-encoded at sticker size (the server sets the real limit). */
const MAX_BYTES = 512 * 1024
const EMPTY: Sticker[] = []

export const useStickers = create<{ stickers: Record<string, Sticker[]> }>(() => ({ stickers: {} }))
export const useServerStickers = (serverKey: string) => useStickers((s) => s.stickers[serverKey] ?? EMPTY)

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('sticker.list', {})
    .then(({ stickers }) => useStickers.setState((s) => ({ stickers: { ...s.stickers, [serverKey]: stickers } })))
    .catch(() => undefined) // older servers have no stickers
})

onServerEvent((serverKey, type, body) => {
  if (type !== 'stickers.updated') return
  const { stickers } = body as Events['stickers.updated']
  useStickers.setState((s) => ({ stickers: { ...s.stickers, [serverKey]: stickers } }))
})

export function sendSticker(serverKey: string, channelId: number, sticker: Sticker, options: Pick<SendOptions, 'replyTo'> = {}): Promise<void> {
  return sendMessage(serverKey, channelId, '', { ...options, sticker })
}

/** Still images bigger than 320 px (or JPEGs) are shrunk to a PNG; GIFs must already fit. */
export async function prepareStickerImage(file: File): Promise<File> {
  if (!/^image\/(png|gif|webp|jpeg)$/.test(file.type)) throw new Error(t('chat.stickers.wrongType'))
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {
      throw new Error(t('chat.stickers.unreadable'))
    })
    const { naturalWidth: width, naturalHeight: height } = image
    if (file.type === 'image/gif') {
      if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(t('chat.stickers.tooLarge', { side: MAX_SIDE }))
      return file
    }
    if (file.type !== 'image/jpeg' && width <= MAX_SIDE && height <= MAX_SIDE && file.size <= MAX_BYTES) return file
    const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')!
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error(t('chat.stickers.unreadable'))
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.png', { type: 'image/png' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

const connection = (serverKey: string) => {
  const c = connectionFor(serverKey)
  if (!c?.isOnline) throw new Error(t('errors.codes.disconnected'))
  return c
}

export async function addSticker(serverKey: string, file: File, name: string): Promise<void> {
  const uploaded = await uploadFile(serverKey, await prepareStickerImage(file), () => undefined)
  await connection(serverKey).request('sticker.create', { name, fileId: uploaded.id })
}

export const renameSticker = (serverKey: string, id: string, name: string) => connection(serverKey).request('sticker.rename', { id, name })
export const deleteSticker = (serverKey: string, id: string) => connection(serverKey).request('sticker.delete', { id })
