// Starting the speech-to-text worker (captions.worker.ts), shared by live captions and voice message transcripts:
// where the model comes from (the server's members-only link), whether it's on this device already, and loading it
// (checked against its SHA-256, kept on the device) into a fresh worker.
import { loadSilero } from '../audio/assets'
import { captionModelCached, captionSource, loadCaptionModel, WHISPER_CONFIG, type CaptionSource } from '../models'
import { connectionFor, useApp } from '../store'
import type { CaptionLanguage } from './whisper'

export interface WhisperSource {
  source: CaptionSource
  /** The model is on this device already. */
  cached: boolean
  /** The server said it doesn't offer the model ('no'), or couldn't be asked. */
  offered: 'yes' | 'no' | 'unreachable'
}

/** Where to get the model for `serverKey` (asked even when it's kept here: a part that went bad is fetched again). */
export async function findWhisperSource(serverKey: string): Promise<WhisperSource> {
  let source: CaptionSource = { base: useApp.getState().servers[serverKey]?.url ?? '', query: '' }
  const [cached, found] = await Promise.all([captionModelCached(), captionSource(source.base, async () => {
    const connection = connectionFor(serverKey)
    if (!connection) throw new Error('not connected')
    return connection.request('captions.model.link', {})
  })])
  if (typeof found === 'object') source = found
  return { source, cached, offered: typeof found === 'object' ? 'yes' : found }
}

/**
 * Loads the model from `source` (or this device) and starts a worker with it, ready to take voices or transcripts.
 * Throws ModelError for download trouble, Error when the worker can't start.
 */
export async function startWhisperWorker(
  source: CaptionSource, language: CaptionLanguage | 'auto', onProgress: (done: number) => void, signal: AbortSignal,
): Promise<Worker> {
  const [files, silero] = await Promise.all([loadCaptionModel(source, onProgress, signal), loadSilero()])
  const worker = new Worker(new URL('./captions.worker.ts', import.meta.url), { type: 'module' })
  try {
    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
        if (e.data.type === 'ready') resolve()
        else if (e.data.type === 'error') reject(new Error(e.data.message))
      }
      worker.onerror = (e) => reject(new Error(e.message || 'captions worker failed'))
    })
    const vocab = JSON.parse(new TextDecoder().decode(files.vocab)) as Record<string, number>
    worker.postMessage({
      type: 'init', ortWasm: files.runtime.buffer, encoder: files.encoder, decoder: files.decoder, vocab, config: WHISPER_CONFIG,
      silero: silero.slice(0), language,
    }, [files.runtime.buffer, files.encoder.buffer, files.decoder.buffer])
    await ready
    return worker
  } catch (e) {
    worker.terminate()
    throw e
  }
}
