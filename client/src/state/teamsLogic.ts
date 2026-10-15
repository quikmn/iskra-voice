// Splitting people into teams: random, balanced by a skill number, or picked by captains (snake draft). Pure functions,
// tested in teamsLogic.test.ts; the dialog is ui/teams/TeamsDialog.tsx. The server only checks and moves.

export const MIN_TEAMS = 2
export const MAX_TEAMS = 8
export const MIN_SKILL = 1
export const MAX_SKILL = 10
export const DEFAULT_SKILL = 5

export type Rng = () => number

/** A copy in random order (Fisher–Yates). */
export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Team sizes as even as possible: 7 people in 3 teams → [3, 2, 2]. */
export function teamSizes(people: number, teams: number): number[] {
  return Array.from({ length: teams }, (_, i) => Math.floor(people / teams) + (i < people % teams ? 1 : 0))
}

/** How many teams make sense for this many people (at least one each). */
export const maxTeamsFor = (people: number) => Math.max(MIN_TEAMS, Math.min(MAX_TEAMS, people))

/** Random teams of even sizes. */
export function randomTeams(people: readonly string[], count: number, rng: Rng = Math.random): string[][] {
  const teams: string[][] = Array.from({ length: count }, () => [])
  shuffle(people, rng).forEach((key, i) => teams[i % count].push(key))
  return teams
}

/** Each person's skill: theirs if set, else the average of those set (or the default when nobody has one). */
export function skillsFor(people: readonly string[], set: Readonly<Record<string, number>>): Record<string, number> {
  const known = people.map((k) => set[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : DEFAULT_SKILL
  return Object.fromEntries(people.map((k) => [k, typeof set[k] === 'number' && Number.isFinite(set[k]) ? set[k] : fallback]))
}

export const teamTotal = (team: readonly string[], skill: Readonly<Record<string, number>>) => team.reduce((sum, k) => sum + (skill[k] ?? 0), 0)

/** The gap between the strongest and weakest team: 0 is perfectly even. */
export function spread(teams: readonly (readonly string[])[], skill: Readonly<Record<string, number>>): number {
  const totals = teams.map((t) => teamTotal(t, skill))
  return totals.length ? Math.max(...totals) - Math.min(...totals) : 0
}

const squares = (teams: readonly (readonly string[])[], skill: Readonly<Record<string, number>>) =>
  teams.reduce((sum, t) => sum + teamTotal(t, skill) ** 2, 0)

/**
 * Teams of even sizes whose skill totals are as close as can be found: strongest first into the weakest team with room,
 * then swaps between teams while one makes them closer. People with the same skill come in random order, so asking
 * again ("Reshuffle") gives a different but equally fair split when there is one.
 */
export function balancedTeams(people: readonly string[], count: number, skill: Readonly<Record<string, number>>, rng: Rng = Math.random): string[][] {
  const sizes = teamSizes(people.length, count)
  const teams: string[][] = Array.from({ length: count }, () => [])
  const totals = new Array<number>(count).fill(0)
  const order = shuffle(people, rng).sort((a, b) => (skill[b] ?? 0) - (skill[a] ?? 0))
  for (const key of order) {
    let best = -1
    for (const i of shuffle([...teams.keys()], rng)) {
      if (teams[i].length >= sizes[i]) continue
      if (best < 0 || totals[i] < totals[best]) best = i
    }
    teams[best].push(key)
    totals[best] += skill[key] ?? 0
  }
  // Swaps keep the sizes; each one must lower the sum of squared totals (so it always ends).
  for (let round = 0; round < 200; round++) {
    let improved = false
    let score = squares(teams, skill)
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        for (let i = 0; i < teams[a].length; i++) {
          for (let j = 0; j < teams[b].length; j++) {
            const x = teams[a][i]
            const y = teams[b][j]
            if ((skill[x] ?? 0) === (skill[y] ?? 0)) continue
            teams[a][i] = y
            teams[b][j] = x
            const next = squares(teams, skill)
            if (next < score - 1e-9) {
              score = next
              improved = true
            } else {
              teams[a][i] = x
              teams[b][j] = y
            }
          }
        }
      }
    }
    if (!improved) break
  }
  return teams
}

/** Snake draft: which team picks next after `picked` picks (0, 1, 2, 2, 1, 0, 0, 1, …). */
export function nextPicker(picked: number, count: number): number {
  const round = Math.floor(picked / count)
  const at = picked % count
  return round % 2 === 0 ? at : count - 1 - at
}

/** Captains' teams so far: each captain leads a team, then the picks in snake order. */
export function draftTeams(captains: readonly string[], picks: readonly string[]): string[][] {
  const teams = captains.map((c) => [c])
  picks.forEach((key, i) => teams[nextPicker(i, captains.length)]?.push(key))
  return teams
}

/** Moves one person to another team (for hand-tuning a preview). */
export function moveToTeam(teams: readonly (readonly string[])[], key: string, to: number): string[][] {
  return teams.map((team, i) => (i === to ? (team.includes(key) ? [...team] : [...team, key]) : team.filter((k) => k !== key)))
}

/** The names sent to the server: "Valheim team 1" when a game is given, else "Team 1" (in the app's language). */
export function teamNames(count: number, game: string, label: (n: number) => string): string[] {
  const g = game.trim()
  return Array.from({ length: count }, (_, i) => (g ? `${g} ${label(i + 1)}` : label(i + 1)).slice(0, 32))
}

/** Ready for "Go": at least two teams, nobody left in an empty team. */
export const canStart = (teams: readonly (readonly string[])[]) => teams.length >= MIN_TEAMS && teams.every((t) => t.length > 0)
