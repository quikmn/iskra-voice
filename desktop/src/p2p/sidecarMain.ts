// The iskra-p2p program (see sidecar.ts). Its own file so nothing runs when the desktop app loads sidecar.ts.
import { runSidecar } from './sidecar'

// A signal stops it the same clean way as the end of stdin.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => process.stdin.destroy())

runSidecar({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`iskra-p2p: ${e.stack ?? e.message}\n`)
    process.exit(1)
  },
)
