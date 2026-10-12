// Server settings → Channels (manageChannels): every category and channel in one list, each opening the same
// dialogs as the channel list's menus (name, who can see and post, slowmode, permissions, delete). Arranging by
// drag stays in the channel list itself.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Category, Channel } from '../../core/protocol'
import { useCategories } from '../../state/organize'
import { layoutChannels } from '../../state/organizeLogic'
import type { ServerState } from '../../state/store'
import { CreateChannelDialog } from '../dialogs/CreateChannelDialog'
import { CategoryDialog, ChannelSettingsDialog } from '../organize/Dialogs'
import { Hash, Plus, Volume } from '../icons'

type Open = { kind: 'channel'; channel: Channel } | { kind: 'category'; category?: Category } | { kind: 'new'; categoryId: number | null }

export function ChannelsSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const categories = useCategories(server.key)
  const layout = layoutChannels(server.channels, categories)
  const [open, setOpen] = useState<Open | null>(null)
  const close = () => setOpen(null)
  const row = (channel: Channel) => (
    <li key={channel.id}>
      <button className="room-channel" onClick={() => setOpen({ kind: 'channel', channel })}
        aria-label={t('settings.channels.edit', { name: channel.name })}>
        <span className="room-channel-icon" aria-hidden>{channel.kind === 'voice' || channel.kind === 'stage' ? <Volume size={16} /> : <Hash size={16} />}</span>
        <span className="room-channel-name">{channel.name}</span>
        <span className="muted">{t(`settings.channels.kinds.${channel.kind}`)}</span>
      </button>
    </li>
  )
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.channels')}</h2>
      <p className="muted">{t('settings.channels.intro')}</p>
      <div className="copy-row">
        <button className="button primary" onClick={() => setOpen({ kind: 'new', categoryId: null })}><Plus size={16} /> {t('organize.list.createChannel')}</button>
        <button className="button" onClick={() => setOpen({ kind: 'category' })}>{t('organize.category.create')}</button>
      </div>
      {layout.uncategorized.length > 0 && <ul className="room-channels">{layout.uncategorized.map(row)}</ul>}
      {layout.groups.map(({ category, channels }) => (
        <div key={category.id} className="room-category">
          <div className="room-category-head">
            <strong>{category.name}</strong>
            <button className="button small" onClick={() => setOpen({ kind: 'category', category })}
              aria-label={t('settings.channels.renameCategory', { name: category.name })}>{t('organize.category.rename')}</button>
          </div>
          {channels.length > 0 ? <ul className="room-channels">{channels.map(row)}</ul> : <p className="muted">{t('settings.channels.emptyCategory')}</p>}
        </div>
      ))}
      {open?.kind === 'channel' && <ChannelSettingsDialog server={server} channel={server.channels.find((c) => c.id === open.channel.id) ?? open.channel} onClose={close} />}
      {open?.kind === 'category' && <CategoryDialog server={server} category={open.category} onClose={close} />}
      {open?.kind === 'new' && <CreateChannelDialog server={server} categoryId={open.categoryId} onClose={close} />}
    </section>
  )
}
