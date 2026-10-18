// Recording a call: the page streams each person's audio here and we write it into a folder of its own under the
// recordings folder the person picked (default Documents/Iskra recordings). The page never names a path: it gives
// the server's and channel's names (made safe here) and file names (checked here), and only ever gets ids back.
// Nothing is deleted: when something goes wrong, what was written so far stays.
import { randomBytes } from 'node:crypto'
import { mkdir, open, statfs, writeFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

/** Recording stops when less than this is free on the disk. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024
/** ...and doesn't start with less than this. */
export const START_FREE_BYTES = 600 * 1024 * 1024
/** The most one write may carry (the page sends about a second of audio at a time). */
export const MAX_WRITE = 4 * 1024 * 1024
/** Files in one recording (people joining and leaving, or opting out and back in, each start a file). */
export const MAX_FILES = 500
export const MAX_INFO = 64 * 1024
/** How much may be written between free-space checks. */
const CHECK_EVERY = 16 * 1024 * 1024

export type FreeSpace = (dir: string) => Promise<number>
const statfsFree: FreeSpace = async (dir) => {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** A folder name from a server's or channel's name: one level, nothing Windows refuses, not empty. */
export function folderPart(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f"*:<>?|/\\]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 60)
  return cleaned && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) ? cleaned : fallback
}

/** The recording's own folder: its local start time, 2026-10-18 21-05-09. */
export function stampName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
}

/** A file name the page asked for: a plain "<name>.webm" in the recording's folder, or null. */
export function trackName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length > 80 || !name.toLowerCase().endsWith('.webm')) return null
  const base = name.slice(0, -5)
  return folderPart(base, '') === base && base ? name : null
}

interface Session {
  owner: number
  folder: string
  files: Set<string>
  count: number
  ended: boolean
}

interface OpenFile {
  session: string
  owner: number
  handle: FileHandle
  offset: number
  chain: Promise<unknown>
  sinceCheck: number
  failed: boolean
}

export class Recordings {
  private readonly sessions = new Map<string, Session>()
  private readonly files = new Map<string, OpenFile>()
  private readonly free: FreeSpace

  constructor(free: FreeSpace = statfsFree) {
    this.free = free
  }

  /** Makes <base>/<server>/<channel>/<date time>/ for a new recording. */
  async begin(base: string, server: unknown, channel: unknown, owner: number, at = new Date()): Promise<{ id: string; folder: string } | { error: 'folder' | 'disk' }> {
    const parent = path.join(base, folderPart(server, 'Server'), folderPart(channel, 'Voice'))
    let folder: string
    try {
      await mkdir(parent, { recursive: true })
      if ((await this.free(parent)) < START_FREE_BYTES) return { error: 'disk' }
      folder = await uniqueFolder(path.join(parent, stampName(at)))
    } catch {
      return { error: 'folder' }
    }
    const id = randomBytes(16).toString('hex')
    this.sessions.set(id, { owner, folder, files: new Set(), count: 0, ended: false })
    return { id, folder }
  }

  /** A new file in the recording's folder; its id, or null. */
  async open(id: unknown, name: unknown, owner: number): Promise<string | null> {
    const session = this.session(id, owner)
    const file = trackName(name)
    if (!session || session.ended || !file || session.count >= MAX_FILES) return null
    let handle: FileHandle
    try {
      handle = await open(path.join(session.folder, file), 'wx') // never over something already there
    } catch {
      return null
    }
    session.count++
    const fileId = randomBytes(16).toString('hex')
    session.files.add(fileId)
    this.files.set(fileId, { session: id as string, owner, handle, offset: 0, chain: Promise.resolve(), sinceCheck: CHECK_EVERY, failed: false })
    return fileId
  }

  /** Appends to a file. 'disk': the disk is (nearly) full, so the recording should stop. */
  async write(fileId: unknown, data: unknown, owner: number): Promise<'ok' | 'disk' | 'failed'> {
    const file = this.file(fileId, owner)
    if (!file || file.failed || !(data instanceof Uint8Array) || data.length > MAX_WRITE) return 'failed'
    const at = file.offset
    file.offset += data.length
    const step = file.chain.then(async (): Promise<'ok' | 'disk'> => {
      file.sinceCheck += data.length
      if (file.sinceCheck >= CHECK_EVERY) {
        file.sinceCheck = 0
        const session = this.sessions.get(file.session)
        if (session && (await this.free(session.folder)) < MIN_FREE_BYTES) return 'disk'
      }
      const { bytesWritten } = await file.handle.write(data, 0, data.length, at)
      if (bytesWritten !== data.length) throw new Error('short write')
      return 'ok'
    })
    file.chain = step.catch(() => undefined)
    try {
      const result = await step
      if (result === 'disk') file.failed = true
      return result
    } catch {
      file.failed = true
      return 'failed'
    }
  }

  async close(fileId: unknown, owner: number): Promise<boolean> {
    const file = this.file(fileId, owner)
    if (!file) return false
    this.files.delete(fileId as string)
    this.sessions.get(file.session)?.files.delete(fileId as string)
    await file.chain
    try {
      await file.handle.close()
      return !file.failed
    } catch {
      return false
    }
  }

  /** The info.txt next to the files (written again as the recording goes on). */
  async info(id: unknown, text: unknown, owner: number): Promise<boolean> {
    const session = this.session(id, owner)
    if (!session || typeof text !== 'string' || text.length > MAX_INFO) return false
    try {
      await writeFile(path.join(session.folder, 'info.txt'), process.platform === 'win32' ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** The recording is over: its open files are closed. Its folder can still be shown. */
  async end(id: unknown, owner: number): Promise<void> {
    const session = this.session(id, owner)
    if (!session) return
    session.ended = true
    await Promise.all([...session.files].map((f) => this.close(f, owner)))
  }

  /** The folder of a recording of this page's (to show it), or null. */
  folderOf(id: unknown, owner: number): string | null {
    return this.session(id, owner)?.folder ?? null
  }

  /** The page went away (reload, closed window): its recordings end, keeping what was written. */
  async endAll(owner: number): Promise<void> {
    await Promise.all([...this.sessions].filter(([, s]) => s.owner === owner).map(([id]) => this.end(id, owner)))
    for (const [id, s] of this.sessions) if (s.owner === owner) this.sessions.delete(id)
  }

  get openFiles(): number {
    return this.files.size
  }

  private session(id: unknown, owner: number): Session | null {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined
    return session && session.owner === owner ? session : null
  }

  private file(id: unknown, owner: number): OpenFile | null {
    const file = typeof id === 'string' ? this.files.get(id) : undefined
    return file && file.owner === owner ? file : null
  }
}

/** Makes the folder, or "<folder> (2)" if a recording started in the same second. */
async function uniqueFolder(folder: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? folder : `${folder} (${n})`
    try {
      await mkdir(candidate)
      return candidate
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('no folder')
}
