import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityDetector } from './activity'
import { GAMES, matchGame, parseTasklist, processKey } from './games'

test('process names compare without paths, case or .exe', () => {
  assert.equal(processKey('C:\\Games\\Factorio\\bin\\x64\\Factorio.EXE'), 'factorio')
  assert.equal(processKey('/home/a/.steam/steamapps/common/Factorio/bin/x64/factorio'), 'factorio')
  assert.equal(processKey('Z:\\home\\a\\Games\\eldenring.exe'), 'eldenring') // Proton
  assert.equal(processKey('  Stardew Valley.exe '), 'stardew valley')
})

test('the bundled list is well-formed', () => {
  for (const game of GAMES) {
    assert.ok(game.name.length > 0 && game.name.length <= 64, game.name)
    for (const p of game.processes) assert.equal(p, processKey(p), `${game.name}: ${p}`)
  }
  assert.equal(new Set(GAMES.map((g) => g.name)).size, GAMES.length)
})

test('matches a running game, your own programs first', () => {
  const running = ['System', 'explorer.exe', 'Discord.exe', 'cs2.exe', 'chrome.exe']
  assert.equal(matchGame(running, []), 'Counter-Strike 2')
  assert.equal(matchGame(running, [{ name: 'Practice mode', process: 'CS2.exe' }]), 'Practice mode')
  assert.equal(matchGame(['explorer.exe', 'code.exe'], []), null)
  assert.equal(matchGame(['/usr/bin/bash', '/opt/factorio/bin/x64/factorio'], []), 'Factorio')
})

test('reads tasklist output', () => {
  const csv = '"System Idle Process","0","Services","0","8 K"\r\n"cs2.exe","1234","Console","1","1,024,000 K"\r\n'
  assert.deepEqual(parseTasklist(csv), ['System Idle Process', 'cs2.exe'])
})

test('the detector reports changes only, and nothing once turned off', async () => {
  let running = ['explorer.exe']
  const reports: (string | null)[] = []
  const detector = new ActivityDetector((g) => reports.push(g), async () => running)
  detector.configure(true, [])
  await detector.check()
  running = ['factorio.exe']
  await detector.check()
  await detector.check()
  assert.equal(detector.game, 'Factorio')
  detector.configure(false, [])
  running = ['cs2.exe']
  await detector.check()
  assert.deepEqual(reports, ['Factorio', null])
})

test("the detector keeps what it shows when the programs can't be listed (tasklist failed or timed out)", async () => {
  let running: string[] | null = ['factorio.exe']
  const reports: (string | null)[] = []
  const detector = new ActivityDetector((g) => reports.push(g), async () => running)
  detector.configure(true, [])
  await detector.check()
  running = null
  await detector.check()
  assert.equal(detector.game, 'Factorio')
  assert.deepEqual(reports, ['Factorio'])
  detector.configure(false, [])
})

test('a slow program list is waited for, never started twice at once', async () => {
  let calls = 0
  let answer: (names: string[]) => void = () => undefined
  const reports: (string | null)[] = []
  const detector = new ActivityDetector((g) => reports.push(g), () => {
    calls++
    return new Promise<string[]>((resolve) => { answer = resolve })
  })
  detector.configure(true, [{ name: 'Test Game', process: 'electron.exe' }]) // starts one
  const poll = detector.check() // the next poll while it's still listing: joins it
  assert.equal(calls, 1)
  answer(['electron.exe'])
  await poll
  assert.deepEqual(reports, ['Test Game'])
  const next = detector.check()
  assert.equal(calls, 2)
  answer(['electron.exe'])
  await next
  detector.configure(false, [])
})
