// Restoring a server from a backup in the desktop app: the pure parts (unit-tested in restore.test.ts).

/** What a picked backup file says about itself before the passphrase is entered. */
export interface BackupInfo {
  encrypted: boolean
  /** The server's name, from an encrypted backup's header. */
  name: string | null
}

const MAGIC = 'ISKRABK1'

/** Reads the start of a backup file: "ISKRABK1" + u32be length + header JSON (encrypted), or a zip (a daily backup). Null if neither. */
export function readBackupInfo(head: Uint8Array): BackupInfo | null {
  const text = (from: number, to: number) => new TextDecoder().decode(head.subarray(from, to))
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) return { encrypted: false, name: null }
  if (head.length < 12 || text(0, 8) !== MAGIC) return null
  const length = new DataView(head.buffer, head.byteOffset + 8, 4).getUint32(0, false)
  if (length === 0 || length > 4096 || head.length < 12 + length) return { encrypted: true, name: null }
  try {
    const header = JSON.parse(text(12, 12 + length)) as { name?: unknown }
    return { encrypted: true, name: typeof header.name === 'string' ? header.name.slice(0, 60) : null }
  } catch {
    return { encrypted: true, name: null }
  }
}

/** Only backup downloads from a server are saved through the app: http(s)://host/backup/<token>. */
export function isBackupDownload(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && /^\/backup\/[A-Za-z0-9_-]{16,64}$/.test(parsed.pathname) && !parsed.search
  } catch {
    return false
  }
}

export interface RestorePorts {
  port: number
  voicePort: number
}

/**
 * The restored server.json, adjusted to this computer: free ports, and an address on this network unless the owner
 * set their own (a domain). Everything else (name, HTTPS, internet hosting, limits) stays as it was.
 */
export function adjustRestoredSettings(
  settings: Record<string, unknown>,
  ports: RestorePorts,
  lanHost: string,
  localOnly: boolean,
): Record<string, unknown> {
  const publicUrl = typeof settings.PublicUrl === 'string' ? settings.PublicUrl : null
  const ownAddress = publicUrl !== null && !/^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|127\.)/.test(publicUrl)
  const voice = typeof settings.Voice === 'object' && settings.Voice !== null ? (settings.Voice as Record<string, unknown>) : {}
  return {
    ...settings,
    Port: ports.port,
    PublicUrl: localOnly ? `http://localhost:${ports.port}` : ownAddress ? publicUrl : `http://${lanHost}:${ports.port}`,
    ...(localOnly || settings.LocalOnly === true ? { LocalOnly: true } : {}),
    Voice: { ...voice, Port: ports.voicePort, RtcTcpPort: ports.voicePort + 1, RtcUdpPort: ports.voicePort + 2 },
  }
}
