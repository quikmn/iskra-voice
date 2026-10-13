// Activity status: every 30 s while turned on, list running programs and match them against the game list.
// Only the matched name is reported; the program list is never kept or sent anywhere.
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { matchGame, parseTasklist } from './games'

const POLL_MS = 30_000

/** The program's output, or null if it failed or took too long. */
function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout))
  })
}

/**
 * Names of running programs (Windows: image names; Linux: the program from each command line; macOS: ps), or null
 * when they couldn't be listed this time (tasklist can take several seconds on a busy computer, say while gaming).
 */
export async function runningPrograms(): Promise<string[] | null> {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/fo', 'csv', '/nh'])
    return out === null ? null : parseTasklist(out)
  }
  if (process.platform === 'darwin') return (await run('ps', ['-axo', 'comm=']))?.split('\n') ?? null
  // Linux: /proc/<pid>/cmdline's first part (comm is cut at 15 characters); games under Proton show as their .exe.
  const names: string[] = []
  for (const pid of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid)) continue
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
    const first = cmdline.split('\0')[0]
    if (first) names.push(first)
  }
  return names
}

export class ActivityDetector {
  private timer: NodeJS.Timeout | null = null
  private current: string | null = null
  private custom: { name: string; process: string }[] = []
  private readonly onChange: (game: string | null) => void
  private readonly list: () => Promise<string[] | null>

  constructor(onChange: (game: string | null) => void, list: () => Promise<string[] | null> = runningPrograms) {
    this.onChange = onChange
    this.list = list
  }

  get game(): string | null {
    return this.current
  }

  /** Turns detection on or off, with the user's own programs. Off reports "no game" right away. */
  configure(on: boolean, custom: { name: string; process: string }[]): void {
    this.custom = custom
    if (!on) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.report(null)
      return
    }
    if (!this.timer) this.timer = setInterval(() => void this.check(), POLL_MS)
    void this.check()
  }

  async check(): Promise<void> {
    const programs = await this.list()
    // Turned off meanwhile, or the programs couldn't be listed this time: keep what's shown (not "no game").
    if (!this.timer || programs === null) return
    this.report(matchGame(programs, this.custom))
  }

  private report(game: string | null): void {
    if (game === this.current) return
    this.current = game
    this.onChange(game)
  }
}
