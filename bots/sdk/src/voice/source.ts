// Where a voice bot's audio comes from: a file on the bot's computer, a file uploaded to the server, a stream
// address the bot's operator chose (fetched by the bot itself), or bytes and streams the bot already has.
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What `play()` takes: a file path, an `http(s)://` address (an internet radio stream, a file), a server file
 * (`/files/<id>/<name>` or `bot.fileUrl(file)`), the bytes, or any stream of bytes (a Node stream, a web stream).
 */
export type AudioInput = string | URL | Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>

export interface OpenedSource {
  chunks: AsyncIterable<Uint8Array>
  /** A name to show when none was given: the file's name or the address. */
  title: string
}

/** Headers must arrive within this; the body (a radio stream) may then go on for as long as it likes. */
const CONNECT_TIMEOUT_MS = 15_000

export async function openSource(input: AudioInput, serverUrl: string, signal: AbortSignal): Promise<OpenedSource> {
  if (input instanceof Uint8Array) return { chunks: once(input), title: 'audio' }
  if (typeof input === 'string' || input instanceof URL) {
    const text = String(input)
    if (text.startsWith('/files/')) return fetchSource(new URL(serverUrl + text), signal)
    if (/^https?:\/\//i.test(text)) return fetchSource(new URL(text), signal)
    const path = text.startsWith('file:') ? fileURLToPath(text) : text
    return { chunks: createReadStream(path, { signal, highWaterMark: 64 * 1024 }), title: basename(path) }
  }
  return { chunks: input as AsyncIterable<Uint8Array>, title: 'stream' }
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

async function fetchSource(url: URL, signal: AbortSignal): Promise<OpenedSource> {
  const connecting = new AbortController()
  const timer = setTimeout(() => connecting.abort(), CONNECT_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.any([connecting.signal, signal]), headers: { Accept: 'audio/*, application/ogg;q=0.9, */*;q=0.5' } })
  } catch (e) {
    throw new Error(connecting.signal.aborted ? `${url.host} didn't answer within ${CONNECT_TIMEOUT_MS / 1000} s.` : `Couldn't reach ${url.host}: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok || !response.body) throw new Error(`${url.host} answered HTTP ${response.status}.`)
  const type = response.headers.get('content-type') ?? ''
  if (/^text\/html/i.test(type)) {
    await response.body.cancel()
    throw new Error(`${url.href} is a web page, not an audio file or stream. Iskra bots play audio files and streams only.`)
  }
  const name = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  return { chunks: response.body as unknown as AsyncIterable<Uint8Array>, title: name || url.host }
}
