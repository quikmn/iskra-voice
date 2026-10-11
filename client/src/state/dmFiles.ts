// Encrypted DM attachments: encrypt and upload (ciphertext only), and download, check and decrypt for display.
import { DmError } from '../core/dm'
import { cleanName, decryptFile, encryptFile, encryptedSize, type DmFile } from '../core/dmFiles'
import { sniff } from '../core/sniff'
import { connectionFor, useApp } from './store'

/** Files are encrypted and decrypted in memory, so they're capped on this side too (servers have their own limit). */
export const MAX_DM_FILE_BYTES = 50 * 1024 * 1024

function put(url: string, body: Uint8Array, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status === 200) resolve((JSON.parse(xhr.responseText) as { file: { id: string } }).file.id)
      else reject(new Error(xhr.status === 413 ? 'That file is too big for this server.' : `Upload failed (${xhr.status}).`))
    }
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(body as Uint8Array<ArrayBuffer>)
  })
}

/** Encrypts a file for a DM with `peer` and uploads the ciphertext to `serverKey` (one you both are on). */
export async function uploadDmFile(
  serverKey: string, peer: string, file: File, onProgress: (fraction: number) => void,
  signal?: AbortSignal, voice?: DmFile['voice'],
): Promise<DmFile> {
  if (file.size > MAX_DM_FILE_BYTES) throw new Error(`Files in direct messages can be up to ${MAX_DM_FILE_BYTES / 1024 / 1024} MB.`)
  const server = useApp.getState().servers[serverKey]
  const connection = connectionFor(serverKey)
  if (!server || !connection?.isOnline) throw new Error('Not connected.')
  const plain = new Uint8Array(await file.arrayBuffer())
  const { ciphertext, key, hash } = encryptFile(plain)
  const { url } = await connection.request('dm.upload.begin', { accountKey: peer, size: ciphertext.length })
  const id = await put(server.url + url, ciphertext, onProgress, signal)
  return {
    server: serverKey, id, key, hash, name: cleanName(file.name), type: (file.type || 'application/octet-stream').slice(0, 100), size: plain.length,
    ...(voice ? { voice } : {}),
  }
}

export interface OpenedFile {
  /** A blob: URL of the decrypted bytes. */
  url: string
  /** From the decrypted bytes, never from the sender's claim. */
  type: string
  inline: boolean
}

const opened = new Map<string, Promise<OpenedFile>>()

/** Downloads, verifies and decrypts an attachment (once per session). */
export function openDmFile(file: DmFile): Promise<OpenedFile> {
  const tag = `${file.server}:${file.id}:${file.hash}`
  let run = opened.get(tag)
  if (!run) {
    run = fetchAndDecrypt(file)
    opened.set(tag, run)
    run.catch(() => opened.delete(tag)) // let a later try go again
  }
  return run
}

async function fetchAndDecrypt(file: DmFile): Promise<OpenedFile> {
  if (file.size > MAX_DM_FILE_BYTES) throw new DmError('This file is too big to open here.')
  const server = useApp.getState().servers[file.server]
  const connection = connectionFor(file.server)
  if (!server || !connection?.isOnline) throw new DmError("The server that has this file isn't connected right now.")
  const { url } = await connection.request('dm.file.url', { id: file.id })
  const response = await fetch(server.url + url)
  if (!response.ok) throw new DmError("Couldn't download this file.")
  const expected = encryptedSize(file.size)
  if (Number(response.headers.get('content-length') ?? expected) !== expected) throw new DmError("This file doesn't match what was sent.")
  const plain = decryptFile(new Uint8Array(await response.arrayBuffer()), file)
  const kind = sniff(plain.subarray(0, 64))
  // Only types channels show inline get their real type; everything else stays an opaque download.
  const blob = new Blob([plain as Uint8Array<ArrayBuffer>], { type: kind.inline ? kind.type : 'application/octet-stream' })
  return { url: URL.createObjectURL(blob), type: kind.type, inline: kind.inline }
}
