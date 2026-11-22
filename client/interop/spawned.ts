// The processes the interop tests start (iskra-server, which runs LiveKit and the p2p sidecar itself and relays their
// lines into its own output, and bots): their last output lines are kept, and a wait for one of them to be ready fails
// with those lines and the exit code or signal. A child that exits before it is ready fails the wait at once, not
// after the timeout.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { resolve } from 'node:path'

export const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')

const KEPT_LINES = 60
const LINE_LENGTH = 600

export interface Kept {
  readonly proc: ChildProcess
  /** How it ended, or undefined while it runs. */
  readonly exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  /** Its last lines (stdout and stderr together). */
  lines(): string[]
  /** "<name> exited with code 1 (or: is still running). Its last lines: ..." for an error message. */
  describe(): string
  /**
   * Polls `check` until it gives something truthy (a throw counts as not yet). Fails as soon as the child has exited,
   * or after `timeoutMs`, with the child's last lines.
   */
  ready<T>(what: string, check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs?: number): Promise<T>
  /** Kills it if it still runs and waits until it's gone. */
  stop(): Promise<void>
}

/** Keeps the output of a child started with piped stdout and stderr. */
export function keep(proc: ChildProcess, name: string): Kept {
  const kept: string[] = []
  let partial = ''
  const take = (chunk: Buffer | string) => {
    const parts = (partial + chunk.toString()).split('\n')
    partial = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trimEnd()
      if (line) kept.push(line.length > LINE_LENGTH ? `${line.slice(0, LINE_LENGTH)}…` : line)
    }
    if (kept.length > KEPT_LINES) kept.splice(0, kept.length - KEPT_LINES)
  }
  proc.stdout?.on('data', take)
  proc.stderr?.on('data', take)
  let exit: Kept['exit']
  let failed: Error | undefined
  // 'exit' says how it ended; 'close' comes once its output has ended too (a moment later, or never if a grandchild
  // holds the pipe), so a failure waits briefly for it to have the last lines. 'error': it couldn't be started.
  let markGone!: () => void
  const gone = new Promise<void>((done) => (markGone = done))
  const closed = new Promise<void>((done) => proc.once('close', () => done()))
  proc.once('exit', (code, signal) => {
    exit = { code, signal }
    markGone()
  })
  proc.once('error', (e) => {
    failed = e
    exit ??= { code: null, signal: null }
    markGone()
  })
  const flushed = () => Promise.race([closed, new Promise((r) => setTimeout(r, 1000))])
  const lines = () => (partial.trim() ? [...kept, partial.trimEnd()] : [...kept])
  const describe = () => {
    const state = failed ? `could not be started (${failed.message})`
      : !exit ? `is still running (pid ${proc.pid})`
      : exit.signal ? `was stopped by ${exit.signal}`
      : `exited with code ${exit.code}`
    const output = lines()
    return `${name} ${state}. ${output.length ? `Its last lines:\n${output.join('\n')}` : 'It wrote nothing.'}`
  }
  return {
    proc,
    get exit() {
      return exit
    },
    lines,
    describe,
    async ready(what, check, timeoutMs = 30_000) {
      const started = Date.now()
      let lastError = ''
      for (;;) {
        // Looked at before the check: a child that has gone can't become ready, whatever else answers on its port.
        if (exit) {
          await flushed()
          throw new Error(`${what}: ${describe()}`)
        }
        try {
          const value = await check()
          if (value) return value
        } catch (e) {
          lastError = (e as Error).message
        }
        if (exit) continue
        if (Date.now() - started > timeoutMs)
          throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${lastError ? ` (${lastError})` : ''}. ${describe()}`)
        await Promise.race([gone, new Promise((r) => setTimeout(r, 100))])
      }
    },
    async stop() {
      if (!exit) proc.kill()
      await gone
    },
  }
}

/** Starts a child with its output kept. stdin is closed unless `stdin` is 'pipe'. */
export function spawnKept(name: string, command: string, args: string[], options: SpawnOptions & { stdin?: 'pipe' | 'ignore' } = {}): Kept {
  const { stdin = 'ignore', ...rest } = options
  return keep(spawn(command, args, { ...rest, stdio: [stdin, 'pipe', 'pipe'] }), name)
}

/** The real iskra-server on a world folder (its server.json is already there). */
export const spawnServer = (world: string, options: SpawnOptions & { stdin?: 'pipe' | 'ignore' } = {}): Kept =>
  spawnKept('iskra-server', 'dotnet', [SERVER_DLL, world], options)

/** A check for `ready`: the address answers a GET with a 2xx. One try never hangs longer than 5 s. */
export const answers = (url: string) => async (): Promise<boolean> => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5000) })).ok
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    throw new Error(`${url}: ${cause?.code ?? cause?.message ?? (e as Error).message}`)
  }
}

/**
 * A check for `ready`: the server says voice can be joined (GET /health, voice "up"). That is what `voice.join` goes
 * by, and it comes a moment after LiveKit's own port answers (the server warms LiveKit up first).
 */
export const voiceUp = (serverUrl: string) => async (): Promise<boolean> => {
  const url = `${serverUrl.replace(/\/$/, '')}/health`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    const voice = ((await response.json()) as { voice?: string }).voice
    if (voice !== 'up') throw new Error(`voice is ${voice}`)
    return true
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    throw new Error(`${url}: ${cause?.code ?? cause?.message ?? (e as Error).message}`)
  }
}
