// Backups, moving a server and Discord imports (owner tools in Settings → This server).
import { create } from 'zustand'
import { b64u, fromB64u, sealToServer } from '../core/crypto'
import type { Events, ImportJob } from '../core/protocol'
import { desktop } from '../platform/desktop'
import { connectionFor, onServerEvent, useApp } from './store'
import { t } from '../i18n'

interface BackupProgress {
  done: number
  total: number
}

interface BackupState {
  /** serverKey → bytes written while a backup is being made. */
  progress: Record<string, BackupProgress | undefined>
  /** serverKey → the latest import (live while it runs). */
  imports: Record<string, ImportJob | undefined>
}

export const useBackups = create<BackupState>(() => ({ progress: {}, imports: {} }))

onServerEvent((serverKey, type, body) => {
  if (type === 'backup.progress') {
    const progress = body as Events['backup.progress']
    useBackups.setState((s) => ({ progress: { ...s.progress, [serverKey]: progress } }))
  } else if (type === 'import.progress') {
    const { job } = body as Events['import.progress']
    useBackups.setState((s) => ({ imports: { ...s.imports, [serverKey]: job } }))
  }
})

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('settings.backup.notConnected'))
  return c
}

export const MIN_PASSPHRASE = 8

/** How strong a passphrase looks, roughly: enough to nudge people away from short ones. */
export function passphraseStrength(passphrase: string): 'too-short' | 'weak' | 'ok' | 'strong' {
  const text = passphrase.trim()
  if (text.length < MIN_PASSPHRASE) return 'too-short'
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(text)).length
  const words = text.split(/\s+/).filter(Boolean).length
  if (text.length >= 20 || (words >= 4 && text.length >= 16)) return 'strong'
  if (text.length >= 12 && kinds >= 2) return 'ok'
  return 'weak'
}

export const PASSPHRASE_CONTEXT = 'iskra/backup-passphrase/v1'

export function sealPassphrase(serverKey: string, passphrase: string): string {
  return b64u(sealToServer(fromB64u(serverKey), PASSPHRASE_CONTEXT, new TextEncoder().encode(passphrase)))
}

/** Makes an encrypted backup on the server and returns where to download it (an absolute URL). */
export async function createBackup(serverKey: string, passphrase: string): Promise<{ url: string; name: string; size: number }> {
  useBackups.setState((s) => ({ progress: { ...s.progress, [serverKey]: { done: 0, total: 0 } } }))
  try {
    // Sealed to the server key we verified in the handshake: the passphrase never crosses the network in the clear.
    const sealedPassphrase = sealPassphrase(serverKey, passphrase)
    const result = await connection(serverKey).request('backup.create', { sealedPassphrase }, 30 * 60_000)
    const base = useApp.getState().servers[serverKey]?.url ?? ''
    return { url: base + result.url, name: result.name, size: result.size }
  } finally {
    useBackups.setState((s) => ({ progress: { ...s.progress, [serverKey]: undefined } }))
  }
}

/** Starts the download: the desktop app asks where to save it; a browser saves it like any download. */
export function downloadFile(url: string): void {
  if (desktop?.download) {
    void desktop.download(url)
    return
  }
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** Uploads an export and starts the import; progress then arrives as import.progress events. */
export async function startImport(serverKey: string, file: File, readOnly: boolean, onUpload: (fraction: number) => void): Promise<void> {
  const server = useApp.getState().servers[serverKey]
  if (!server) throw new Error(t('settings.backup.notConnected'))
  const { url } = await connection(serverKey).request('import.begin', { size: file.size, readOnly })
  useBackups.setState((s) => ({ imports: { ...s.imports, [serverKey]: undefined } }))
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', server.url + url)
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload(e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status === 202) resolve()
      else if (xhr.status === 413) reject(new Error(t('settings.import.tooBig')))
      else if (xhr.status === 415) reject(new Error(t('settings.import.wrongType')))
      else reject(new Error(t('settings.import.uploadFailedStatus', { status: xhr.status })))
    }
    xhr.onerror = () => reject(new Error(t('settings.import.uploadFailed')))
    xhr.send(file)
  })
}

export async function loadImportStatus(serverKey: string): Promise<void> {
  const { job } = await connection(serverKey).request('import.status', {})
  if (job) useBackups.setState((s) => ({ imports: { ...s.imports, [serverKey]: s.imports[serverKey] ?? job } }))
}

export function cancelImport(serverKey: string): Promise<unknown> {
  return connection(serverKey).request('import.cancel', {})
}

/** "1.4 GB", in the app's language. */
export { formatBytes } from '../i18n/format'

/** 0–1 for a progress bar (null while there's nothing to measure yet). */
export function importFraction(job: ImportJob): number | null {
  if (job.phase === 'done') return 1
  if (job.phase !== 'importing' || job.messages === 0) return null
  return Math.min(1, job.messagesDone / job.messages)
}
