// Which invite people joined with (moderators only; PROTOCOL.md "Invite tracking"), and webhook signing secrets. The
// server checks every request; this only asks. Pure rules are in inviteTrackRules.ts.
import { useEffect, useMemo, useState } from 'react'
import type { JoinedVia, Member, Webhook } from '../core/protocol'
import { joinInvites } from './inviteTrackRules'
import { isModerator } from './reports'
import { useServerRoles } from './roles'
import { t } from '../i18n'
import { connectionFor, type ServerState } from './store'

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

export async function loadJoins(serverKey: string, filter: { accountKey?: string; inviteId?: string } = {}): Promise<JoinedVia[]> {
  return (await connection(serverKey).request('invite.joins', filter)).joins
}

/**
 * Current members' joins, for moderators (null while loading, on errors and for everyone else). `refresh` changing
 * loads them again (say, when someone joins).
 */
export function useJoins(serverKey: string, moderator: boolean, refresh?: unknown): JoinedVia[] | null {
  const [joins, setJoins] = useState<JoinedVia[] | null>(null)
  useEffect(() => {
    if (!moderator) return
    let cancelled = false
    loadJoins(serverKey).then(
      (list) => !cancelled && setJoins(list),
      () => !cancelled && setJoins(null),
    )
    return () => {
      cancelled = true
    }
  }, [serverKey, moderator, refresh])
  return moderator ? joins : null
}

/**
 * Server settings → Members, for moderators: the joins, a "Joined with" filter over them (an invite's public id, or
 * "" for all), and whether a member passes it.
 */
export function useMemberJoins(server: ServerState) {
  const roles = useServerRoles(server.key)
  const joins = useJoins(server.key, isModerator(server.me, roles), Object.keys(server.members).length)
  const [inviteId, setInviteId] = useState('')
  const byKey = useMemo(() => Object.fromEntries((joins ?? []).map((j) => [j.accountKey, j])), [joins])
  const invites = useMemo(() => joinInvites(joins ?? []), [joins])
  const passes = (m: Member) => !inviteId || byKey[m.accountKey]?.invite.id === inviteId
  return { joins, byKey, invites, inviteId, setInviteId, passes }
}

/** Sets (or with "" removes) an incoming webhook's signing secret. */
export async function setSigningSecret(serverKey: string, id: string, secret: string): Promise<Webhook> {
  return (await connection(serverKey).request('webhook.signing.set', { id, secret })).webhook
}
