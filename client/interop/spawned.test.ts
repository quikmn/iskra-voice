// The start waits of the interop tests say why they failed: the child's last lines and how it ended.
import { describe, expect, it } from 'vitest'
import { answers, spawnKept } from './spawned'

const failure = (wait: Promise<unknown>) => wait.then(() => 'ready', (e: Error) => e.message)

describe('waiting for a spawned process', () => {
  it('fails at once, with its output and exit code, when the child exits before it is ready', async () => {
    const child = spawnKept('The child', process.execPath, ['-e', 'console.log("starting"); console.error("address already in use"); process.exit(3)'])
    const started = Date.now()
    const message = await failure(child.ready('the child', () => false, 60_000))
    expect(Date.now() - started).toBeLessThan(30_000) // not the 60 s timeout
    expect(message).toContain('the child: The child exited with code 3. Its last lines:')
    expect(message).toContain('starting\naddress already in use')
    expect(child.exit).toEqual({ code: 3, signal: null })
    await child.stop() // gone already: returns
  })

  it('a timeout shows what the child wrote so far, that it still runs, and the last reason', async () => {
    const child = spawnKept('The child', process.execPath, ['-e', 'console.log("listening soon"); setInterval(() => {}, 1000)'])
    try {
      await child.ready('its first line', () => child.lines().length > 0)
      const message = await failure(child.ready('the port', answers('http://127.0.0.1:10080/'), 300))
      expect(message).toMatch(/^Timed out after 0 s waiting for the port \(http:\/\/127\.0\.0\.1:10080\/: bad port\)\. The child is still running \(pid \d+\)\. Its last lines:\nlistening soon$/)
    } finally {
      await child.stop()
    }
    expect(child.exit).toBeDefined()
  })

  it('keeps only the last lines', async () => {
    const child = spawnKept('The child', process.execPath, ['-e', 'for (let i = 1; i <= 500; i++) console.log("line " + i)'])
    const message = await failure(child.ready('never', () => false))
    expect(child.lines()).toHaveLength(60)
    expect(child.lines()[0]).toBe('line 441')
    expect(message).toContain('line 500')
  })

  it('says so when the program cannot be started', async () => {
    const child = spawnKept('The child', 'no-such-program-iskra-interop', [])
    expect(await failure(child.ready('the child', () => false))).toMatch(/^the child: The child could not be started \(.*ENOENT.*\)\. It wrote nothing\.$/)
  })
})
