// Encrypted DM attachments: encrypt and upload (ciphertext only), and download, check and decrypt for display or saving.
// Both ways stream, a part at a time, so a file of any size the server takes never has to fit in memory whole
// (except where a platform can only save from memory; see saveDmFile).
import { DmError } from '../core/dm'
import { t } from '../i18n'
import { cleanName, encryptedSize, FILE_CHUNK, FileDecryptor, FileEncryptor, type DmFile } from '../core/dmFiles'
import { sniff } from '../core/sniff'
import { desktop } from '../platform/desktop'
import { connectionFor, useApp } from './store'

/** Plaintext read, encrypted and sent per request: 128 chunks, a little over 8 MiB of ciphertext. */
const PART_CHUNKS = 128
/** Decrypted bytes handed to a file on disk per write. */
const WRITE_BYTES = 4 * 1024 * 1024
/** Over this, saving from memory gets a note (it can be slow or fail on phones). */
export const IN_MEMORY_NOTE_BYTES = 200 * 1024 * 1024

interface Sent {
  status: number
  body: unknown
}

const cancelled = () => new DOMException(t('dms.files.uploadCancelled'), 'AbortError')

/** One PUT with upload progress; rejects only on network failure or cancel. */
function put(url: string, body: Blob | Uint8Array, onLoaded: (bytes: number) => void, signal?: AbortSignal): Promise<Sent> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled())
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => onLoaded(e.loaded)
    xhr.onload = () => {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(xhr.responseText)
      } catch {
        /* not JSON */
      }
      resolve({ status: xhr.status, body: parsed })
    }
    xhr.onerror = () => reject(new Error(t('dms.files.uploadFailed')))
    xhr.onabort = () => reject(cancelled())
    const abort = () => xhr.abort()
    signal?.addEventListener('abort', abort, { once: true })
    xhr.onloadend = () => signal?.removeEventListener('abort', abort)
    xhr.send(body as Uint8Array<ArrayBuffer>)
  })
}

function failed(status: number): Error {
  return new Error(status === 413 ? t('dms.files.tooBigForServer') : t('dms.files.uploadFailedStatus', { status }))
}

function fileId(sent: Sent): string {
  const id = (sent.body as { file?: { id?: unknown } } | null)?.file?.id
  if (sent.status !== 200 || typeof id !== 'string') throw failed(sent.status)
  return id
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sends one part of an upload in parts (PROTOCOL.md, "Upload in parts"). A dropped connection is retried from where the
 * server says it is. Resolves with the file id after the last part, else null.
 */
async function putPart(url: string, offset: number, part: Uint8Array, onLoaded: (bytes: number) => void, signal?: AbortSignal): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    let sent: Sent
    try {
      sent = await put(`${url}?offset=${offset}`, part, onLoaded, signal)
    } catch (e) {
      if ((e as Error).name === 'AbortError' || attempt >= 3) throw e
      onLoaded(0)
      await wait(1000 * 2 ** attempt)
      continue
    }
    const body = sent.body as { file?: { id?: unknown }; received?: unknown } | null
    if (sent.status === 200) {
      if (typeof body?.file?.id === 'string') return body.file.id
      if (body?.received === offset + part.length) return null
      throw failed(sent.status)
    }
    // The server already had this part (its answer got lost on the way), or wants it again.
    if (sent.status === 409 && body?.received === offset + part.length) return null
    if (sent.status === 409 && body?.received === offset && attempt < 3) continue
    throw failed(sent.status)
  }
}

async function readSlice(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer())
}

/** Encrypts a file for a DM with `peer` (or a group DM: `{ groupId }`) and uploads the ciphertext to `serverKey`. */
export async function uploadDmFile(
  serverKey: string, peer: string | { groupId: string } | { channelId: number }, file: File, onProgress: (fraction: number) => void,
  signal?: AbortSignal, voice?: DmFile['voice'],
): Promise<DmFile> {
  const server = useApp.getState().servers[serverKey]
  const connection = connectionFor(serverKey)
  if (!server || !connection?.isOnline) throw new Error(t('errors.codes.disconnected'))
  const size = file.size
  const total = encryptedSize(size)
  const begun = await connection.request('dm.upload.begin', { ...(typeof peer === 'string' ? { accountKey: peer } : peer), size: total })
  const url = server.url + begun.url
  const encryptor = new FileEncryptor(size)
  // As much plaintext per part as fits the server's part limit (header included), at most PART_CHUNKS chunks.
  const partBytes = typeof begun.partBytes === 'number' ? begun.partBytes : 0
  const chunksPerPart = Math.min(PART_CHUNKS, Math.floor((partBytes - 64) / (FILE_CHUNK + 17)))
  const plainPerPart = chunksPerPart * FILE_CHUNK
  let id: string | null = null

  if (chunksPerPart < 1 || size <= plainPerPart) {
    // One request: small files, or a server without parts (then the ciphertext is gathered in a Blob first).
    const pieces: Uint8Array<ArrayBuffer>[] = []
    let at = 0
    do {
      const end = Math.min(size, at + PART_CHUNKS * FILE_CHUNK)
      pieces.push(encryptor.push(await readSlice(file, at, end)) as Uint8Array<ArrayBuffer>)
      at = end
      if (signal?.aborted) throw cancelled()
    } while (at < size)
    id = fileId(await put(url, new Blob(pieces), (loaded) => onProgress(loaded / total), signal))
  } else {
    let sent = 0
    for (let at = 0; at < size; at += plainPerPart) {
      if (signal?.aborted) throw cancelled()
      const part = encryptor.push(await readSlice(file, at, Math.min(size, at + plainPerPart)))
      const base = sent
      id = await putPart(url, base, part, (loaded) => onProgress((base + loaded) / total), signal)
      sent += part.length
    }
    if (!id || sent !== total) throw new Error(t('dms.files.uploadFailed'))
  }
  const { key, hash } = encryptor.finish()
  onProgress(1)
  return {
    server: serverKey, id, key, hash, name: cleanName(file.name), type: (file.type || 'application/octet-stream').slice(0, 100), size,
    ...(voice ? { voice } : {}),
  }
}

// ── Downloading ─────────────────────────────────────────────────────────────

/** Where decrypted bytes go. Nothing counts as received until `close`, which only runs after every check passed. */
interface Sink {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

/**
 * Downloads a file's ciphertext and decrypts it chunk by chunk into `sink`, in writes of a few MB. The FINAL chunk, the
 * length and the hash are checked before `sink.close()`; on any failure (or cancel) the sink is aborted.
 */
async function streamDmFile(file: DmFile, sink: Sink, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  try {
    const server = useApp.getState().servers[file.server]
    const connection = connectionFor(file.server)
    if (!server || !connection?.isOnline) throw new DmError(t('dms.files.serverOffline'))
    const { url } = await connection.request('dm.file.url', { id: file.id })
    const response = await fetch(server.url + url, { signal })
    if (!response.ok || !response.body) throw new DmError(t('dms.files.downloadFailed'))
    const decryptor = new FileDecryptor(file)
    if (Number(response.headers.get('content-length') ?? decryptor.total) !== decryptor.total) throw new DmError(t('dms.errors.fileMismatch'))

    let batch: Uint8Array[] = []
    let batched = 0
    const flush = async () => {
      if (!batched) return
      const data = batch.length === 1 ? batch[0] : join(batch, batched)
      batch = []
      batched = 0
      await sink.write(data)
    }
    const reader = response.body.getReader()
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      for (const plain of decryptor.push(value)) {
        batch.push(plain)
        batched += plain.length
        if (batched >= WRITE_BYTES) await flush()
      }
      onProgress?.(received / decryptor.total)
    }
    const last = decryptor.finish()
    if (last.length) {
      batch.push(last)
      batched += last.length
    }
    await flush()
  } catch (e) {
    await sink.abort().catch(() => {})
    if ((e as Error).name === 'AbortError') throw e
    throw e instanceof DmError ? e : new DmError(t('dms.files.downloadFailed'))
  }
  await sink.close()
}

function join(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Collects the file in memory (a Blob). */
function memorySink(): Sink & { blob(type: string): Blob; head(): Uint8Array } {
  const parts: Uint8Array<ArrayBuffer>[] = []
  return {
    head: () => parts[0]?.subarray(0, 64) ?? new Uint8Array(0),
    write: async (data) => void parts.push(data as Uint8Array<ArrayBuffer>),
    close: async () => {},
    abort: async () => void (parts.length = 0),
    blob: (type) => new Blob(parts, { type }),
  }
}

export interface OpenedFile {
  /** A blob: URL of the decrypted bytes. */
  url: string
  /** From the decrypted bytes, never from the sender's claim. */
  type: string
  inline: boolean
  /** The decrypted bytes (voice message transcripts read them; blob: URLs can't be fetched under the CSP). */
  blob: Blob
}

const opened = new Map<string, Promise<OpenedFile>>()
const openProgress = new Map<string, Set<(fraction: number) => void>>()

/** Downloads, verifies and decrypts an attachment into memory, for showing it (once per session). */
export function openDmFile(file: DmFile, onProgress?: (fraction: number) => void): Promise<OpenedFile> {
  const tag = `${file.server}:${file.id}:${file.hash}`
  if (onProgress) {
    const listeners = openProgress.get(tag) ?? new Set()
    listeners.add(onProgress)
    openProgress.set(tag, listeners)
  }
  let run = opened.get(tag)
  if (!run) {
    const sink = memorySink()
    run = streamDmFile(file, sink, (fraction) => openProgress.get(tag)?.forEach((listener) => listener(fraction))).then(() => {
      const kind = sniff(sink.head())
      // Only types channels show inline get their real type; everything else stays an opaque download.
      const blob = sink.blob(kind.inline ? kind.type : 'application/octet-stream')
      return { url: URL.createObjectURL(blob), type: kind.type, inline: kind.inline, blob }
    })
    opened.set(tag, run)
    run.catch(() => opened.delete(tag)) // let a later try go again
    run.then(() => openProgress.delete(tag), () => openProgress.delete(tag))
  }
  return run
}

// ── Saving to disk ──────────────────────────────────────────────────────────

interface WritableFile {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
interface SavedFileHandle {
  createWritable(): Promise<WritableFile>
  getFile(): Promise<Blob>
  remove?(): Promise<void>
}
type SaveFilePicker = (options: { suggestedName?: string }) => Promise<SavedFileHandle>

const savePicker = () => (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker

/** Whether this app can save a decrypted file straight to disk (the desktop app, or a browser with showSaveFilePicker). */
export function canStreamToDisk(): boolean {
  return !!desktop?.saveFile || typeof savePicker() === 'function'
}

/**
 * Asks where to save, then downloads, decrypts and writes the file there a few MB at a time. Call it straight from a
 * click (the browser's picker needs one). 'cancelled' if no place was chosen. The file only gets its name once every
 * check passed; otherwise the partial file is deleted and this rejects.
 */
export async function saveDmFile(file: DmFile, name: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<'saved' | 'cancelled'> {
  let sink: Sink
  const bridge = desktop?.saveFile
  const picker = savePicker()
  if (bridge) {
    const id = await bridge.begin(name)
    if (!id) return 'cancelled'
    sink = {
      write: async (data) => {
        if (!(await bridge.write(id, data))) throw new DmError(t('dms.files.saveFailed'))
      },
      close: async () => {
        if (!(await bridge.finish(id))) throw new DmError(t('dms.files.saveFailed'))
      },
      abort: () => bridge.abort(id),
    }
  } else if (picker) {
    let handle: SavedFileHandle
    let writable: WritableFile
    try {
      handle = await picker.call(globalThis, { suggestedName: name })
      writable = await handle.createWritable()
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled'
      throw new DmError(t('dms.files.saveFailed'))
    }
    // Chromium writes to a temporary file and only puts it in place on close; abort throws that away. The picker made
    // an empty file under the name (a file the user chose to replace stays as it was): remove it.
    sink = {
      write: (data) => writable.write(data),
      close: () => writable.close(),
      abort: async () => {
        await writable.abort().catch(() => {})
        if ((await handle.getFile()).size === 0) await handle.remove?.()
      },
    }
  } else {
    throw new DmError(t('dms.files.saveFailed'))
  }
  await streamDmFile(file, sink, onProgress, signal)
  return 'saved'
}
