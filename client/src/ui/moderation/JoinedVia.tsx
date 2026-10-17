// Which invite people joined with, for moderators (PROTOCOL.md "Invite tracking"): a line in the member dialog's
// moderator tools, and a "Joined with" filter plus a line per person in Server settings → Members.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JoinedVia } from '../../core/protocol'
import { loadJoins, type useMemberJoins } from '../../state/invitetrack'
import { inviteName, joinedViaText } from '../../state/inviteTrackRules'
import type { ServerState } from '../../state/store'
import { fullTime, messageTime } from '../format'
import '../invitetrack.css'

const nameIn = (server: ServerState) => (key: string) => server.members[key]?.name

/** Member dialog (moderators): "Joined with “Reddit post” from Anna · 3 days ago". */
export function JoinedViaLine({ server, accountKey }: { server: ServerState; accountKey: string }) {
  const { t } = useTranslation()
  const [join, setJoin] = useState<JoinedVia | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    loadJoins(server.key, { accountKey }).then((list) => !cancelled && setJoin(list[0] ?? null), () => !cancelled && setJoin(undefined))
    return () => {
      cancelled = true
    }
  }, [server.key, accountKey])
  if (join === undefined) return null
  return (
    <p className="muted joined-via" data-testid="joined-via">
      {join ? <>{joinedViaText(join, nameIn(server))} · <time title={fullTime(join.joinedAt)}>{messageTime(join.joinedAt)}</time></> : t('invitetrack.notTracked')}
    </p>
  )
}

export function JoinFilter({ state }: { state: ReturnType<typeof useMemberJoins> }) {
  const { t } = useTranslation()
  if (!state.joins || state.invites.length === 0) return null
  return (
    <label className="field">
      <span>{t('invitetrack.filter')}</span>
      <select value={state.inviteId} onChange={(e) => state.setInviteId(e.target.value)} data-testid="join-filter">
        <option value="">{t('invitetrack.filterAny')}</option>
        {state.invites.map(({ invite, count }) => (
          <option key={invite.id} value={invite.id}>{t('invitetrack.filterOption', { invite: inviteName(invite), count })}</option>
        ))}
      </select>
    </label>
  )
}

/** The small line under a member's name in the list. */
export function JoinedViaText({ server, join }: { server: ServerState; join: JoinedVia | undefined }) {
  if (!join) return null
  return <span className="muted joined-via-text" data-testid="joined-via-text">{joinedViaText(join, nameIn(server))}</span>
}
