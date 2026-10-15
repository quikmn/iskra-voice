// Team splits: each server's active splits, the splitter dialog, and session skill numbers (kept in memory only, for
// tonight's games). The app makes the teams; the server checks who may be moved, makes the team channels and moves.
import { create } from 'zustand'
import type { Events, Member, ServerRole, TeamSplit } from '../core/protocol'
import { has, outranks } from './permissions'
import { connectionFor, onServerEvent, onWelcomeHook, useApp, type ServerState } from './store'
import { joinVoice, useVoice } from './voice'

interface TeamsState {
  splits: Record<string, TeamSplit[]>
  /** The splitter dialog: which voice channel it's for. */
  open: { serverKey: string; channelId: number } | null
  /** Skill numbers set this session, per server and person. */
  skills: Record<string, Record<string, number>>
}

export const useTeams = create<TeamsState>(() => ({ splits: {}, open: null, skills: {} }))

const NONE: TeamSplit[] = []
export const useSplits = (serverKey: string | undefined) => useTeams((s) => (serverKey ? s.splits[serverKey] ?? NONE : NONE))

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('not connected')
  return c
}

const keep = (serverKey: string, update: (list: TeamSplit[]) => TeamSplit[]) =>
  useTeams.setState((s) => ({ splits: { ...s.splits, [serverKey]: update(s.splits[serverKey] ?? []) } }))

export const openTeams = (serverKey: string, channelId: number) => useTeams.setState({ open: { serverKey, channelId } })
export const closeTeams = () => useTeams.setState({ open: null })

export function setSkill(serverKey: string, accountKey: string, skill: number | null): void {
  useTeams.setState((s) => {
    const mine = { ...(s.skills[serverKey] ?? {}) }
    if (skill === null) delete mine[accountKey]
    else mine[accountKey] = skill
    return { skills: { ...s.skills, [serverKey]: mine } }
  })
}

export async function startTeams(serverKey: string, channelId: number, teams: string[][], names: string[], game: string): Promise<TeamSplit> {
  const { split } = await connection(serverKey).request('teams.start', { channelId, teams, names, ...(game.trim() ? { game: game.trim() } : {}) })
  keep(serverKey, (list) => [...list.filter((s) => s.id !== split.id), split])
  return split
}

export async function endTeams(serverKey: string, id: number): Promise<number> {
  const { moved } = await connection(serverKey).request('teams.end', { id })
  return moved
}

/** The split a voice channel belongs to: as the channel everyone came from, or as one of its team channels. */
export function splitOf(splits: readonly TeamSplit[], channelId: number | null | undefined): TeamSplit | null {
  if (channelId == null) return null
  return splits.find((s) => s.channelId === channelId || s.teams.some((t) => t.channelId === channelId)) ?? null
}

/** May I move this person (myself, or someone below me, with the move power)? Mirrors the server's check. */
export function canMove(me: Member | null | undefined, target: Member | undefined, roles: ServerRole[]): boolean {
  if (!me || !target || target.bot) return false
  return target.accountKey === me.accountKey || outranks(me, target, roles)
}

export const canSplit = (server: ServerState, roles: ServerRole[]) => has(server.me, roles, 'moveMembers')

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('teams.list', {})
    .then(({ splits }) => keep(serverKey, () => splits))
    .catch(() => undefined) // an older server: no teams
})

onServerEvent((serverKey, type, body) => {
  if (type === 'teams.split') {
    const { split } = body as Events['teams.split']
    keep(serverKey, (list) => [...list.filter((s) => s.id !== split.id), split])
  }
  if (type === 'voice.moved' && (body as Events['voice.moved']).reason === 'teams') {
    // Follow at once, before LiveKit's removal from the old room ends the session (roles.ts then finds us joining).
    const { channelId } = body as Events['voice.moved']
    const session = useVoice.getState().session
    if (session?.serverKey === serverKey && !session.call && !session.group) void joinVoice(serverKey, channelId)
  }
  if (type === 'teams.ended') {
    const { id } = body as Events['teams.ended']
    keep(serverKey, (list) => list.filter((s) => s.id !== id))
  }
})

// A server we left: forget its splits.
useApp.subscribe((state, previous) => {
  for (const key of Object.keys(previous.servers)) if (!state.servers[key] && useTeams.getState().splits[key]) keep(key, () => [])
})
