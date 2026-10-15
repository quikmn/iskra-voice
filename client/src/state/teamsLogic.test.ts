import { describe, expect, it } from 'vitest'
import {
  balancedTeams, canStart, draftTeams, moveToTeam, nextPicker, randomTeams, shuffle, skillsFor, spread, teamNames, teamSizes, teamTotal,
} from './teamsLogic'

/** A small deterministic generator (mulberry32), so failures can be replayed. */
function seeded(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const people = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)
const sorted = (teams: string[][]) => teams.flat().sort()

describe('team sizes and random teams', () => {
  it('spreads people as evenly as possible', () => {
    expect(teamSizes(7, 3)).toEqual([3, 2, 2])
    expect(teamSizes(8, 2)).toEqual([4, 4])
    expect(teamSizes(2, 2)).toEqual([1, 1])
  })

  it('keeps everyone exactly once, in even teams', () => {
    for (let seed = 1; seed < 50; seed++) {
      const teams = randomTeams(people(11), 3, seeded(seed))
      expect(sorted(teams)).toEqual(people(11).sort())
      expect(teams.map((t) => t.length).sort()).toEqual([3, 4, 4])
    }
  })

  it('shuffles without losing anyone', () => {
    const list = people(20)
    const mixed = shuffle(list, seeded(3))
    expect([...mixed].sort()).toEqual([...list].sort())
    expect(mixed).not.toEqual(list)
  })
})

describe('balanced teams', () => {
  it('finds the even split when there is one', () => {
    const skill = { a: 9, b: 8, c: 7, d: 4, e: 3, f: 1 }
    for (let seed = 1; seed < 30; seed++) {
      const teams = balancedTeams(Object.keys(skill), 2, skill, seeded(seed))
      expect(spread(teams, skill)).toBe(0)
      expect(teams.map((t) => t.length)).toEqual([3, 3])
    }
  })

  it('beats a greedy split that leaves a gap', () => {
    // 36 in all: 18 each is possible (8+7+2+1), which takes swaps after the greedy pass.
    const skill = { a: 8, b: 7, c: 6, d: 5, e: 4, f: 3, g: 2, h: 1 }
    const teams = balancedTeams(Object.keys(skill), 2, skill, seeded(7))
    expect(spread(teams, skill)).toBe(0)
  })

  it('stays fair across many teams and keeps sizes even', () => {
    for (let seed = 1; seed < 40; seed++) {
      const rng = seeded(seed)
      const keys = people(13)
      const skill = Object.fromEntries(keys.map((k) => [k, 1 + Math.floor(rng() * 10)]))
      const teams = balancedTeams(keys, 4, skill, rng)
      expect(sorted(teams)).toEqual([...keys].sort())
      expect(teams.map((t) => t.length).sort()).toEqual([3, 3, 3, 4])
      // Never worse than the best single swap could fix: within the strongest player's skill.
      expect(spread(teams, skill)).toBeLessThanOrEqual(10)
    }
  })

  it('gives different splits on reshuffle when skills tie', () => {
    const keys = people(8)
    const skill = Object.fromEntries(keys.map((k) => [k, 5]))
    const seen = new Set<string>()
    for (let seed = 1; seed < 20; seed++) seen.add(JSON.stringify(balancedTeams(keys, 2, skill, seeded(seed)).map((t) => [...t].sort()).sort()))
    expect(seen.size).toBeGreaterThan(3)
  })

  it('fills in missing skills with the average of the set ones', () => {
    expect(skillsFor(['a', 'b', 'c'], { a: 2, b: 8 })).toEqual({ a: 2, b: 8, c: 5 })
    expect(skillsFor(['a'], {})).toEqual({ a: 5 })
    expect(teamTotal(['a', 'b'], { a: 2, b: 8 })).toBe(10)
  })
})

describe('captains pick', () => {
  it('drafts in snake order', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => nextPicker(n, 2))).toEqual([0, 1, 1, 0, 0, 1])
    expect([0, 1, 2, 3, 4, 5].map((n) => nextPicker(n, 3))).toEqual([0, 1, 2, 2, 1, 0])
    expect(draftTeams(['A', 'B'], ['c', 'd', 'e', 'f'])).toEqual([['A', 'c', 'f'], ['B', 'd', 'e']])
  })
})

describe('tuning and starting', () => {
  it('moves someone between teams', () => {
    expect(moveToTeam([['a', 'b'], ['c']], 'b', 1)).toEqual([['a'], ['c', 'b']])
    expect(moveToTeam([['a'], ['c']], 'c', 1)).toEqual([['a'], ['c']])
  })

  it('needs two teams with someone in each', () => {
    expect(canStart([['a'], ['b']])).toBe(true)
    expect(canStart([['a', 'b'], []])).toBe(false)
    expect(canStart([['a']])).toBe(false)
  })

  it('names teams after the game when there is one', () => {
    const label = (n: number) => `Team ${n}`
    expect(teamNames(2, '', label)).toEqual(['Team 1', 'Team 2'])
    expect(teamNames(2, ' Valheim ', label)).toEqual(['Valheim Team 1', 'Valheim Team 2'])
    expect(teamNames(1, 'x'.repeat(40), label)[0].length).toBe(32)
  })
})
