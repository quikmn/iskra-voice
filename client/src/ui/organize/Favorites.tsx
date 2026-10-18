// Favorites: channels you starred, from any server, at the top of Home (the direct-messages sidebar). Click jumps to
// the channel; Edit shows arrows and a remove button on each row (dragging reorders too). Starring is in the channel menu.
import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp, selectChannel, selectServer } from '../../state/store'
import { dropFavoriteBefore, stepFavorite, setFavorite, useFavorites } from '../../state/favorites'
import { sameFavorite, visibleFavorites, type Favorite } from '../../state/favoritesLogic'
import { useNotifyFor } from '../../state/organize'
import { channelBadges } from '../../state/organizeLogic'
import { useChannelCounts } from '../../state/unread'
import { setStageOpen } from '../../state/voice'
import type { Channel } from '../../core/protocol'
import { ChannelKindIcon } from '../ChannelKindIcon'
import { ServerPicture } from '../ServerPicture'
import { ChevronDown, ChevronUp, Close } from '../icons'
import './organize.css'

type Entry = ReturnType<typeof visibleFavorites<{ key: string; name: string; channels: Channel[] }>>[number]

export function FavoritesSection({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation()
  const items = useFavorites((s) => s.settings.items)
  const servers = useApp((s) => s.servers)
  const [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState<Favorite | null>(null)
  const [over, setOver] = useState<Favorite | null>(null)
  const rows = visibleFavorites(items, servers)
  if (rows.length === 0) return null

  return (
    <div className="fav-section" role="group" aria-label={t('favorites.section')}>
      <div className="channel-group">
        <span>{t('favorites.section')}</span>
        {rows.length > 1 && (
          <button className="fav-edit" onClick={() => setEditing(!editing)} aria-pressed={editing} title={t('favorites.hint')}>
            {editing ? t('favorites.done') : t('favorites.edit')}
          </button>
        )}
      </div>
      {rows.map((row, i) => (
        <FavoriteRow
          key={`${row.fav.server}/${row.fav.channel}`}
          row={row} first={i === 0} last={i === rows.length - 1} editing={editing} onNavigate={onNavigate}
          dropping={!!over && sameFavorite(over, row.fav) && !!drag && !sameFavorite(drag, row.fav)}
          dragProps={{
            draggable: true,
            onDragStart: (e: DragEvent) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', '')
              setDrag(row.fav)
            },
            onDragOver: (e: DragEvent) => {
              if (!drag) return
              e.preventDefault()
              if (!over || !sameFavorite(over, row.fav)) setOver(row.fav)
            },
            onDrop: (e: DragEvent) => {
              e.preventDefault()
              if (drag) dropFavoriteBefore(drag, row.fav)
              setDrag(null)
              setOver(null)
            },
            onDragEnd: () => {
              setDrag(null)
              setOver(null)
            },
          }}
        />
      ))}
    </div>
  )
}

function FavoriteRow({ row, first, last, editing, dropping, dragProps, onNavigate }: {
  row: Entry
  first: boolean
  last: boolean
  editing: boolean
  dropping: boolean
  dragProps: Record<string, unknown>
  onNavigate: () => void
}) {
  const { t } = useTranslation()
  const { fav, server, channel } = row
  const notify = useNotifyFor(server.key, channel.id)
  const counts = useChannelCounts(server.key, channel)
  const shown = channelBadges(counts.unread, counts.mentions, notify)
  const label = channel.kind === 'voice' ? channel.name : `#${channel.name}`
  return (
    <div className={`org-row fav-row ${dropping ? 'drop-before' : ''}`} {...dragProps} data-testid="favorite">
      <button
        className={`channel fav-channel ${shown.unread ? 'unread' : ''} ${shown.dimmed ? 'muted' : ''}`}
        title={t('favorites.row', { channel: label, server: server.name })}
        onClick={() => {
          setStageOpen(false)
          selectServer(server.key)
          selectChannel(server.key, channel.id)
          onNavigate()
        }}
      >
        <span className="fav-server" aria-hidden><ServerPicture server={server} /></span>
        <span className="hash"><ChannelKindIcon kind={channel.kind} /></span>
        <span className="channel-name">{channel.name}</span>
        {shown.pings > 0 && <span className="badge" title={t('organize.list.mentions')}>{shown.pings}</span>}
      </button>
      {editing && (
        <span className="fav-actions">
          <button className="icon-button small" disabled={first} onClick={() => stepFavorite(fav, -1)} aria-label={t('favorites.moveUp', { channel: label })} title={t('favorites.moveUp', { channel: label })}>
            <ChevronUp size={14} />
          </button>
          <button className="icon-button small" disabled={last} onClick={() => stepFavorite(fav, 1)} aria-label={t('favorites.moveDown', { channel: label })} title={t('favorites.moveDown', { channel: label })}>
            <ChevronDown size={14} />
          </button>
          <button className="icon-button small" onClick={() => setFavorite(fav, false)} aria-label={t('favorites.removeNamed', { channel: label })} title={t('favorites.removeNamed', { channel: label })}>
            <Close size={14} />
          </button>
        </span>
      )}
    </div>
  )
}
