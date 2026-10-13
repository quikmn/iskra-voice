import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TunnelledVoice, webrtcPolicyFor } from './webrtcPolicy'

test('one any-address socket only while voice goes through the tunnel', () => {
  assert.equal(webrtcPolicyFor(false), 'default')
  assert.equal(webrtcPolicyFor(true), 'default_public_interface_only')
})

test('the page flips it on before a tunnelled room connects and off when it leaves; junk changes nothing', () => {
  const voice = new TunnelledVoice()
  assert.equal(voice.policy, 'default')
  assert.equal(voice.set(true), 'default_public_interface_only')
  assert.equal(voice.set(true), null) // already on: nothing to apply
  assert.equal(voice.policy, 'default_public_interface_only')
  assert.equal(voice.set('yes'), null)
  assert.equal(voice.set(1), null)
  assert.equal(voice.policy, 'default_public_interface_only')
  assert.equal(voice.set(false), 'default')
  assert.equal(voice.set(false), null)
  assert.equal(voice.policy, 'default')
})
