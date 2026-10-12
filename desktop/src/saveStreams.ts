// Saving a big decrypted file (an encrypted DM attachment) straight to disk, a piece at a time, so it never has to fit
// in memory. The page picks nothing: the path comes from our own Save dialog. Bytes go to "<name>.iskra-part" and the
// file only gets its real name once the page has checked the whole thing; on failure or cancel the part file is deleted.
import { randomBytes } from 'node:crypto'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

/** The most one write may carry (the page sends a few MB at a time). */
export const MAX_WRITE = 16 * 1024 * 1024

interface Save {
  owner: number
  target: string
  temp: string
  handle: FileHandle
}

export class SaveStreams {
  private readonly saves = new Map<string, Save>()

  /** Starts writing toward `target` for the page `owner`; returns the save's id. */
  async begin(target: string, owner: number): Promise<string> {
    const temp = `${target}.iskra-part`
    const handle = await open(temp, 'w')
    const id = randomBytes(16).toString('hex')
    this.saves.set(id, { owner, target, temp, handle })
    return id
  }

  async write(id: unknown, data: unknown, owner: number): Promise<boolean> {
    const save = this.find(id, owner)
    if (!save || !(data instanceof Uint8Array) || data.length > MAX_WRITE) return false
    try {
      await save.handle.write(data)
      return true
    } catch {
      await this.abort(id, owner)
      return false
    }
  }

  /** Closes the part file and gives it its real name (replacing a file the user chose to overwrite). */
  async finish(id: unknown, owner: number): Promise<boolean> {
    const save = this.find(id, owner)
    if (!save) return false
    this.saves.delete(id as string)
    try {
      await save.handle.close()
      await rename(save.temp, save.target)
      return true
    } catch {
      await rm(save.temp, { force: true }).catch(() => {})
      return false
    }
  }

  async abort(id: unknown, owner: number): Promise<void> {
    const save = this.find(id, owner)
    if (!save) return
    this.saves.delete(id as string)
    await save.handle.close().catch(() => {})
    await rm(save.temp, { force: true }).catch(() => {})
  }

  /** The page went away (reload, closed window): drop its unfinished saves. */
  async abortAll(owner: number): Promise<void> {
    await Promise.all([...this.saves].filter(([, s]) => s.owner === owner).map(([id]) => this.abort(id, owner)))
  }

  get open(): number {
    return this.saves.size
  }

  private find(id: unknown, owner: number): Save | null {
    const save = typeof id === 'string' ? this.saves.get(id) : undefined
    return save && save.owner === owner ? save : null
  }
}

/** A name the page suggests, made safe to put in the Save dialog: no folders, no characters Windows refuses. */
export function suggestedName(name: unknown): string {
  if (typeof name !== 'string') return 'file'
  // eslint-disable-next-line no-control-regex
  const cleaned = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f"*:<>?|/]/g, '').trim().replace(/^\.+/, '').slice(0, 120)
  return cleaned || 'file'
}
