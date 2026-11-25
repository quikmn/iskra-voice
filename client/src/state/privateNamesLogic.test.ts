import { describe, expect, it } from 'vitest'
import { applyPrivateName, cleanPrivateName, MAX_PRIVATE_NAMES, ownNameOf, parsePrivateNames, publicNameOf, rekeyPrivateNames, withPrivateName } from './privateNamesLogic'

const key = (n: number) => String(n).padStart(43, 'A')
const BOB = key(1)
const ME = key(2)

describe('private names', () => {
  it('cleans a name', () => {
    expect(cleanPrivateName('  Bobby   from \n work ')).toBe('Bobby from work')
    expect(cleanPrivateName('a​b\u0000c')).toBe('a b c')
    expect(cleanPrivateName('x'.repeat(40))).toHaveLength(32)
    expect(cleanPrivateName('   ')).toBe('')
  })

  it('sets, changes and removes a name', () => {
    const one = withPrivateName({}, BOB, ' Bobby ')!
    expect(one).toEqual({ [BOB]: 'Bobby' })
    expect(withPrivateName(one, BOB, 'Bobby')).toBe(one) // nothing changed
    expect(withPrivateName(one, BOB, 'Robert')).toEqual({ [BOB]: 'Robert' })
    expect(withPrivateName(one, BOB, '')).toEqual({})
    expect(withPrivateName(one, 'not a key', 'x')).toBe(one)
  })

  it('refuses a new name when the list is full, but still changes and removes', () => {
    let names: Record<string, string> = {}
    for (let i = 10; i < 10 + MAX_PRIVATE_NAMES; i++) names = withPrivateName(names, key(i), `n${i}`)!
    expect(withPrivateName(names, BOB, 'Bobby')).toBeNull()
    expect(withPrivateName(names, key(10), 'changed')![key(10)]).toBe('changed')
    expect(Object.keys(withPrivateName(names, key(10), '')!)).toHaveLength(MAX_PRIVATE_NAMES - 1)
  })

  it('reads a stored copy and drops what is malformed', () => {
    expect(parsePrivateNames(null)).toBeNull()
    expect(parsePrivateNames({ v: 2, updatedAt: 1, names: {} })).toBeNull()
    expect(parsePrivateNames({ v: 1, updatedAt: 5, names: { [BOB]: ' Bobby ', short: 'x', [ME]: 7, [key(3)]: '  ' } })).toEqual({ v: 1, updatedAt: 5, names: { [BOB]: 'Bobby' } })
  })

  it('follows a person to a new account key', () => {
    const names = { [BOB]: 'Bobby' }
    expect(rekeyPrivateNames(names, (k) => k)).toBe(names)
    expect(rekeyPrivateNames(names, (k) => (k === BOB ? key(9) : k))).toEqual({ [key(9)]: 'Bobby' })
    // A name already given under the new key wins.
    expect(rekeyPrivateNames({ [BOB]: 'old', [key(9)]: 'new' }, (k) => (k === BOB ? key(9) : k))).toEqual({ [key(9)]: 'new' })
  })

  it('shows your name for a member and keeps what everyone else sees', () => {
    const bob = { accountKey: BOB, name: 'Bob', role: 'member' }
    const shown = applyPrivateName(bob, { [BOB]: 'Bobby' }, ME)
    expect(shown).toEqual({ accountKey: BOB, name: 'Bobby', publicName: 'Bob', role: 'member' })
    expect(publicNameOf(shown)).toBe('Bob')
    // Applying again changes nothing; a new server copy (a rename) keeps your name and updates the public one.
    expect(applyPrivateName(shown, { [BOB]: 'Bobby' }, ME)).toBe(shown)
    expect(applyPrivateName({ ...bob, name: 'Robert' }, { [BOB]: 'Bobby' }, ME)).toMatchObject({ name: 'Bobby', publicName: 'Robert' })
    // Removed: back to exactly what the server sent.
    expect(applyPrivateName(shown, {}, ME)).toEqual(bob)
    expect(applyPrivateName(bob, {}, ME)).toBe(bob)
  })

  it('never renames you, and finds a person under an older key', () => {
    const me = { accountKey: ME, name: 'Me' }
    expect(applyPrivateName(me, { [ME]: 'Boss' }, ME)).toBe(me)
    const old = { accountKey: key(7), name: 'Bob' }
    expect(applyPrivateName(old, { [BOB]: 'Bobby' }, ME, (k) => (k === key(7) ? BOB : k)).name).toBe('Bobby')
  })

  it('knows their own name under a nickname and a private name', () => {
    expect(ownNameOf({ name: 'Bobby', publicName: 'Bobster', profileName: 'Bob' })).toBe('Bob')
    expect(ownNameOf({ name: 'Bobby', publicName: 'Bob' })).toBe('Bob')
    expect(ownNameOf({ name: 'Bob' })).toBe('Bob')
  })
})
