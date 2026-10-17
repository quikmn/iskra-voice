import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adjustRestoredSettings, isBackupDownload, isBuddyAddress, readBackupInfo } from './restore'

function encrypted(header: object): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(12 + json.length + 24)
  out.set(new TextEncoder().encode('ISKRABK1'), 0)
  new DataView(out.buffer).setUint32(8, json.length, false)
  out.set(json, 12)
  return out
}

test('reads what a backup file is', () => {
  assert.deepEqual(readBackupInfo(encrypted({ v: 1, name: 'Game Night' })), { encrypted: true, name: 'Game Night' })
  assert.deepEqual(readBackupInfo(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), { encrypted: false, name: null })
  assert.equal(readBackupInfo(new TextEncoder().encode('hello there, not a backup')), null)
  assert.deepEqual(readBackupInfo(encrypted({ name: 42 })), { encrypted: true, name: null })
})

test('only backup links are saved through the app', () => {
  assert.equal(isBackupDownload('https://chat.example.com/backup/abcdefghijklmnopqrstuvwxyz012345'), true)
  assert.equal(isBackupDownload('http://192.168.1.20:47070/backup/abcdefghijklmnopqrstuvwxyz012345'), true)
  assert.equal(isBackupDownload('file:///etc/passwd'), false)
  assert.equal(isBackupDownload('https://chat.example.com/files/abc/x.exe'), false)
  assert.equal(isBackupDownload('https://chat.example.com/backup/../x'), false)
  assert.equal(isBackupDownload(42), false)
})

test('restored settings get this computer\'s ports and address', () => {
  const lan = adjustRestoredSettings(
    { Name: 'Game Night', Port: 47070, PublicUrl: 'http://192.168.1.5:47070', Voice: { Enabled: true, Port: 7880 }, Https: { Mode: 'off' } },
    { port: 47071, voicePort: 7883 }, '10.0.0.8', false)
  assert.equal(lan.Port, 47071)
  assert.equal(lan.PublicUrl, 'http://10.0.0.8:47071')
  assert.deepEqual(lan.Voice, { Enabled: true, Port: 7883, RtcTcpPort: 7884, RtcUdpPort: 7885 })
  assert.deepEqual(lan.Https, { Mode: 'off' })
  assert.equal(lan.LocalOnly, undefined)

  const own = adjustRestoredSettings({ PublicUrl: 'https://chat.example.com' }, { port: 47070, voicePort: 7880 }, '10.0.0.8', false)
  assert.equal(own.PublicUrl, 'https://chat.example.com')

  const tests = adjustRestoredSettings({ PublicUrl: 'https://chat.example.com' }, { port: 47075, voicePort: 7890 }, '10.0.0.8', true)
  assert.equal(tests.PublicUrl, 'http://localhost:47075')
  assert.equal(tests.LocalOnly, true)
})

test('only takes http(s) addresses for a buddy restore, never something that looks like a flag', () => {
  assert.equal(isBuddyAddress('https://friend.example'), true)
  assert.equal(isBuddyAddress('http://localhost:47070'), true)
  assert.equal(isBuddyAddress('--json'), false)
  assert.equal(isBuddyAddress('-https://friend.example'), false)
  assert.equal(isBuddyAddress('friend.example'), false)
  assert.equal(isBuddyAddress('file:///etc/passwd'), false)
  assert.equal(isBuddyAddress('https://a:b@friend.example'), false)
  assert.equal(isBuddyAddress(' https://friend.example'), false)
  assert.equal(isBuddyAddress(`https://${'a'.repeat(600)}.example`), false)
  assert.equal(isBuddyAddress(42), false)
})
