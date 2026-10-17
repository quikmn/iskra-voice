// Tests for commands.ts, with Node's own test runner: npm test. Add one for each rule you write.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { greeting, helloCard, tally } from './commands.ts'

describe('greeting', () => {
  it('fits the time of day', () => {
    assert.equal(greeting('Ann', 8), 'Good morning, Ann!')
    assert.equal(greeting('Ann', 13), 'Good afternoon, Ann!')
    assert.equal(greeting('Ann', 21), 'Good evening, Ann!')
    assert.equal(greeting('Ann', 2), 'Good night, Ann!')
  })
})

describe('card', () => {
  it('has a button the bot answers', () => {
    const card = helloCard('Ann')
    const button = card.components[0].items[0]
    assert.equal(button.type === 'button' && button.customId, 'starter:wave')
  })
})

describe('tally', () => {
  it('counts words, most first', () => {
    assert.equal(tally('apples, Pears, apples'), 'apples ×2, pears ×1')
    assert.equal(tally(' , '), null)
  })
})
