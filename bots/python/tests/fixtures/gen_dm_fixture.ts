// Makes dm-from-app.json: DM envelopes the app's own code (client/src/core/dm.ts) encrypted to a fixed bot identity, so
// the Python SDK's tests check it reads exactly what the app writes. Envelopes are random, so this is made once and kept.
//   cd bots && node build.mjs python/tests/fixtures/gen_dm_fixture.ts && node dist/gen_dm_fixture.js
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64u, ready, signingKeyPairFromSeed } from '../../../../client/src/core/crypto'
import { generatePrekey, signPrekey } from '../../../../client/src/core/devices'
import { encryptDm } from '../../../../client/src/core/dm'
import { certifyDevice, type Identity } from '../../../../client/src/core/identity'

await ready()
const created = 1760000000000
const seed = (n: number) => new Uint8Array(32).fill(n)
const identity = (a: number, d: number): Identity => {
  const account = signingKeyPairFromSeed(seed(a))
  const device = signingKeyPairFromSeed(seed(d))
  return { account, device, cert: certifyDevice(account, device.publicKey, created) }
}
const bot = identity(1, 2)
const person = identity(9, 10)
const prekey = generatePrekey(Date.now())
const botKey = b64u(bot.account.publicKey)
const personKey = b64u(person.account.publicKey)
const signed = signPrekey(bot, prekey)
const sentAt = Date.now()

const fixture = {
  note: 'Made by gen_dm_fixture.ts with the app\'s dm.ts. The bot is vectors.json v1 (seeds 1 and 2); the person has seeds 9 and 10.',
  bot: {
    accountSeed: b64u(seed(1)), deviceSeed: b64u(seed(2)), created,
    prekeys: [{ publicKey: b64u(prekey.publicKey), secretKey: b64u(prekey.secretKey), created: prekey.created }],
  },
  person: { accountKey: personKey, cert: person.cert },
  messages: [
    // v1: wrapped to the bot's device key.
    { from: personKey, to: botKey, text: 'hello bot 👋', envelope: encryptDm(person, botKey, [bot.cert], [], { text: 'hello bot 👋' }, sentAt) },
    // v2: forward secret, sealed to the bot's signed prekey.
    { from: personKey, to: botKey, text: '/roll 2d6', envelope: encryptDm(person, botKey, [bot.cert], [], { text: '/roll 2d6' }, sentAt, { prekeys: [signed] }) },
    // v3: a disappearing message (1 hour).
    { from: personKey, to: botKey, text: 'gone soon', envelope: encryptDm(person, botKey, [bot.cert], [], { text: 'gone soon' }, sentAt, { prekeys: [signed], expires: 3600 }) },
  ],
}
const out = join(process.cwd(), 'python', 'tests', 'fixtures', 'dm-from-app.json')
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n')
console.log(`Wrote ${out}`)
