// The host's room settings: name, user limit, lock, and who may join while it's locked. Saving sends one room.update;
// invites go at once. Mounted once (Shell) for whichever room asked for it.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { closeRoomSettings, setRoomInvite, updateRoom, useRooms } from '../../state/rooms'
import { MAX_ROOM_NAME, roomSlug } from '../../state/roomsLogic'
import { useApp, type ServerState } from '../../state/store'
import { Avatar, Modal } from '../bits'
import { UserLimitField } from '../rules/UserLimitField'
import './rooms.css'

export function RoomLayer() {
  const open = useRooms((s) => s.open)
  const server = useApp((s) => (open ? s.servers[open.serverKey] : undefined))
  const channel = server?.channels.find((c) => c.id === open?.channelId)
  if (!open || !server || !channel?.room) return null
  return <RoomDialog key={`${open.serverKey}:${open.channelId}`} server={server} channel={channel} />
}

function RoomDialog({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const [name, setName] = useState(channel.name)
  const [userLimit, setUserLimit] = useState(channel.userLimit ?? 0)
  const [locked, setLocked] = useState(channel.room!.locked)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const slug = roomSlug(name)
  const invited = channel.room!.invited
  // People who could use an invite: members other than yourself, invited ones first, then whoever matches the search.
  const people = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return Object.values(server.members)
      .filter((m) => m.accountKey !== server.me?.accountKey && !m.bot)
      .filter((m) => invited.includes(m.accountKey) || (needle.length > 0 && (m.name.toLowerCase().includes(needle) || (m.profileName ?? '').toLowerCase().includes(needle))))
      .sort((a, b) => Number(invited.includes(b.accountKey)) - Number(invited.includes(a.accountKey)) || a.name.localeCompare(b.name))
      .slice(0, 30)
  }, [server.members, server.me?.accountKey, invited, search])

  async function save() {
    if (!slug || busy) return
    setBusy(true)
    try {
      await updateRoom(server.key, channel.id, {
        ...(slug !== channel.name ? { name: slug } : {}),
        ...(userLimit !== (channel.userLimit ?? 0) ? { userLimit } : {}),
        ...(locked !== channel.room!.locked ? { locked } : {}),
      })
      closeRoomSettings()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const invite = (accountKey: string, on: boolean) =>
    setRoomInvite(server.key, channel.id, accountKey, on).then(() => setError(null), (e) => setError(errorMessage(e)))

  return (
    <Modal
      title={t('rooms.settings.title')}
      className="room-dialog"
      onClose={closeRoomSettings}
      footer={
        <>
          <button className="button" onClick={closeRoomSettings}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!slug || busy} onClick={() => void save()} data-testid="room-save">{t('common.save')}</button>
        </>
      }
    >
      <label className="field">
        <span>{t('rooms.settings.name')}</span>
        <input value={name} maxLength={MAX_ROOM_NAME} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        {slug && slug !== name && <small className="muted">{t('rooms.settings.nameHint', { slug })}</small>}
      </label>
      <UserLimitField value={userLimit} onChange={setUserLimit} />
      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
          {t('rooms.settings.locked')}
        </label>
        <small className="muted">{t('rooms.settings.lockedHint')}</small>
      </div>
      <div className="field room-invites">
        <span>{t('rooms.settings.invite')}</span>
        <input value={search} placeholder={t('rooms.settings.search')} aria-label={t('rooms.settings.search')} onChange={(e) => setSearch(e.target.value)} />
        {people.length > 0 ? (
          <ul>
            {people.map((m) => {
              const on = invited.includes(m.accountKey)
              return (
                <li key={m.accountKey}>
                  <Avatar name={m.name} accountKey={m.accountKey} size={24} />
                  <span className="member-name">{m.profileName ?? m.name}</span>
                  {on && <span className="room-invited-mark">{t('rooms.settings.invited')}</span>}
                  <button className="button small" onClick={() => void invite(m.accountKey, !on)}>{on ? t('rooms.settings.remove') : t('rooms.settings.add')}</button>
                </li>
              )
            })}
          </ul>
        ) : search.trim() ? <p className="muted">{t('rooms.settings.nobodyMatches')}</p> : null}
      </div>
      <p className="muted">{t('rooms.settings.emptiesHint')}</p>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
