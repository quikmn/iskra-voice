// Quitting: the app holds its exit only for a bounded while (hosted servers stopping cleanly), and nothing that
// happens meanwhile can keep it from finishing.

/** Resolves once `work` settles, fulfilled or rejected, or after `ms`, whichever comes first. Never rejects. */
export function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    work.then(done, done)
  })
}

type ErrorEvents = Pick<NodeJS.Process, 'on'>
const logging = new WeakSet<ErrorEvents>()

/**
 * From now on (the app is quitting), an error thrown by a late callback (a timer, a child process's exit, a message
 * for a window that's already gone) is logged instead of shown in Electron's modal "A JavaScript error occurred" box:
 * that box blocks the main process, so the app would never finish quitting. Safe to call more than once.
 */
export function logUncaughtErrors(proc: ErrorEvents = process, log: (error: unknown) => void = (e) => console.error('While quitting:', e)): void {
  if (logging.has(proc)) return
  logging.add(proc)
  proc.on('uncaughtException', (error) => log(error))
}
