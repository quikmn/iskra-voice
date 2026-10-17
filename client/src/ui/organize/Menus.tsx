// What you can do with a channel or a category: notifications and mutes for everyone, arranging for admins.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { Category, Channel, NotifyLevel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { markChannelRead, useChannelCounts } from '../../state/unread'
import {
  deleteCategory, moveCategory, moveChannel, muteFor, setNotifyLevel, toggleCollapsed, useCategories, useNotifyFor, useOrganize,
} from '../../state/organize'
import {
  MUTE_CHOICES, layoutChannels, levelLabel, muteChoiceLabel, muteLabel, notifyKey, stepCategory, stepChannel,
} from '../../state/organizeLogic'
import { MenuItem, MenuTitle, OrgMenu, type MenuAnchor } from './OrgMenu'
import { GameNightItems } from '../teams/TeamsBits'
import { RoomMenuItem } from '../rooms/RoomBits'
import { ReadAloudChannelItem } from '../speech/ReadAloud'
import { ClearVoiceStatusItem } from '../voiceStatus/VoiceStatus'
import { SoundMenuRow, SoundMenuView } from '../sounds/SoundSettings'

export type Run = (action: () => Promise<unknown> | void) => () => void

export function useRunner(onClose: () => void): [Run, string | null] {
  const [error, setError] = useState<string | null>(null)
  const run: Run = (action) => () => {
    void (async () => {
      try {
        await action()
        onClose()
      } catch (e) {
        setError(errorMessage(e))
      }
    })()
  }
  return [run, error]
}

/** The level picker and mute choices for the server (channelId null) or one channel. */
export function NotifyViews({ server, channelId, view, setView, run }: {
  server: ServerState
  channelId: number | null
  view: 'levels' | 'mute' | 'sound'
  setView: (v: 'menu') => void
  run: Run
}) {
  const { t } = useTranslation()
  const own = useOrganize((s) => s.notify[server.key]?.[notifyKey(channelId)])
  const serverLevel = useNotifyFor(server.key, null).chosen
  if (view === 'sound') return <SoundMenuView server={server} channelId={channelId} back={() => setView('menu')} run={run} />
  if (view === 'levels') {
    const current = own?.level ?? 'default'
    const pick = (level: NotifyLevel | 'default') => run(() => setNotifyLevel(server.key, channelId, level))
    return (
      <>
        <MenuTitle onBack={() => setView('menu')}>{t('organize.menu.notifyAbout')}</MenuTitle>
        <div className="org-list" role="menu">
          {channelId !== null && (
            <MenuItem checked={current === 'default'} onClick={pick('default')} hint={levelLabel(serverLevel)}>{t('organize.menu.serverDefault')}</MenuItem>
          )}
          {(['all', 'mentions', 'none'] as const).map((level) => (
            <MenuItem key={level} checked={current === level || (channelId === null && current === 'default' && level === serverLevel)} onClick={pick(level)}>
              {levelLabel(level)}
            </MenuItem>
          ))}
        </div>
      </>
    )
  }
  return (
    <>
      <MenuTitle onBack={() => setView('menu')}>{channelId === null ? t('organize.menu.muteServer') : t('organize.menu.muteChannel')}</MenuTitle>
      <div className="org-list" role="menu">
        {MUTE_CHOICES.map((choice) => (
          <MenuItem key={choice.minutes} onClick={run(() => muteFor(server.key, channelId, choice.minutes))}>{muteChoiceLabel(choice)}</MenuItem>
        ))}
      </div>
    </>
  )
}

/** Notification rows shared by the channel menu and the server's notification settings. */
export function NotifyRows({ server, channelId, setView, run }: { server: ServerState; channelId: number | null; setView: (v: 'levels' | 'mute' | 'sound') => void; run: Run }) {
  const { t } = useTranslation()
  const notify = useNotifyFor(server.key, channelId)
  const own = useOrganize((s) => s.notify[server.key]?.[notifyKey(channelId)])
  const clock = useOrganize((s) => s.clock)
  const ownMuted = muteLabel(own?.mutedUntil ?? null, clock)
  const isServer = channelId === null
  return (
    <>
      <MenuItem onClick={() => setView('levels')} hint={levelLabel(notify.chosen)}>{t('organize.menu.notifications')}</MenuItem>
      {ownMuted ? (
        <MenuItem onClick={run(() => muteFor(server.key, channelId, 0))} hint={ownMuted}>{isServer ? t('organize.menu.unmuteServer') : t('organize.menu.unmuteChannel')}</MenuItem>
      ) : (
        <MenuItem onClick={() => setView('mute')} hint={notify.muted ? t('organize.menu.serverIsMuted') : undefined}>{isServer ? t('organize.menu.mute.server') : t('organize.menu.mute.channel')}</MenuItem>
      )}
      <SoundMenuRow server={server} channelId={channelId} open={() => setView('sound')} />
    </>
  )
}

export function ChannelMenu({ server, channel, anchor, isAdmin, onEdit, onClose }: {
  server: ServerState
  channel: Channel
  anchor: MenuAnchor | null
  isAdmin: boolean
  onEdit: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<'menu' | 'levels' | 'mute' | 'sound' | 'move'>('menu')
  const [run, error] = useRunner(onClose)
  const categories = useCategories(server.key)
  const layout = layoutChannels(server.channels, categories)
  const up = stepChannel(layout, channel, -1)
  const down = stepChannel(layout, channel, 1)
  const counts = useChannelCounts(server.key, channel)
  const unread = counts.unread + counts.mentions
  const label = channel.kind === 'voice' ? channel.name : `#${channel.name}`

  return (
    <OrgMenu anchor={anchor} label={t('organize.list.options', { name: label })} onClose={onClose}>
      {view === 'levels' || view === 'mute' || view === 'sound' ? (
        <NotifyViews server={server} channelId={channel.id} view={view} setView={setView} run={run} />
      ) : view === 'move' ? (
        <>
          <MenuTitle onBack={() => setView('menu')}>{t('organize.menu.moveTo', { label })}</MenuTitle>
          <div className="org-list" role="menu">
            <MenuItem checked={channel.categoryId == null} onClick={run(() => moveChannel(server.key, channel.id, null, null))}>{t('organize.channelSettings.noCategory')}</MenuItem>
            {layout.groups.map(({ category }) => (
              <MenuItem key={category.id} checked={channel.categoryId === category.id} onClick={run(() => moveChannel(server.key, channel.id, category.id, null))}>
                {category.name}
              </MenuItem>
            ))}
          </div>
        </>
      ) : (
        <>
          <MenuTitle>{label}</MenuTitle>
          <div className="org-list" role="menu">
            {unread > 0 && (
              <MenuItem onClick={run(() => markChannelRead(server.key, channel.id))}>
                {t('organize.menu.markRead')}
              </MenuItem>
            )}
            {channel.kind !== 'forum' && channel.kind !== 'whiteboard' && <NotifyRows server={server} channelId={channel.id} setView={setView} run={run} />}
            <GameNightItems server={server} channel={channel} onClose={onClose} />
            <RoomMenuItem server={server} channel={channel} onClose={onClose} />
            <ReadAloudChannelItem server={server} channel={channel} />
            <ClearVoiceStatusItem server={server} channel={channel} run={run} />
            {isAdmin && (
              <>
                <div className="org-sep" role="separator" />
                {up && <MenuItem onClick={run(() => moveChannel(server.key, channel.id, up.categoryId, up.before))}>{t('organize.menu.moveUp')}</MenuItem>}
                {down && <MenuItem onClick={run(() => moveChannel(server.key, channel.id, down.categoryId, down.before))}>{t('organize.menu.moveDown')}</MenuItem>}
                <MenuItem onClick={() => setView('move')} hint={categories.find((c) => c.id === channel.categoryId)?.name ?? t('common.none')}>{t('organize.menu.moveToCategory')}</MenuItem>
                <MenuItem onClick={() => { onEdit(); onClose() }}>{t('organize.menu.editChannel')}</MenuItem>
              </>
            )}
          </div>
        </>
      )}
      {error && <p className="error-text sheet-error" role="alert">{error}</p>}
    </OrgMenu>
  )
}

export function CategoryMenu({ server, category, anchor, isAdmin, onCreateChannel, onRename, onClose }: {
  server: ServerState
  category: Category
  anchor: MenuAnchor | null
  isAdmin: boolean
  onCreateChannel: () => void
  onRename: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<'menu' | 'delete'>('menu')
  const [run, error] = useRunner(onClose)
  const categories = useCategories(server.key)
  const collapsed = useOrganize((s) => (s.collapsed[server.key] ?? []).includes(category.id))
  const up = stepCategory(categories, category.id, -1)
  const down = stepCategory(categories, category.id, 1)
  return (
    <OrgMenu anchor={anchor} label={t('organize.list.options', { name: category.name })} onClose={onClose}>
      {view === 'delete' ? (
        <div className="sheet-confirm">
          <strong>{t('organize.menu.deleteTitle', { name: category.name })}</strong>
          <p className="muted">{t('organize.menu.deleteHint')}</p>
          <button className="button danger wide" onClick={run(() => deleteCategory(server.key, category.id))}>{t('organize.menu.deleteCategory')}</button>
          <button className="button wide" onClick={() => setView('menu')}>{t('common.cancel')}</button>
        </div>
      ) : (
        <>
          <MenuTitle>{category.name}</MenuTitle>
          <div className="org-list" role="menu">
            <MenuItem onClick={run(() => toggleCollapsed(server.key, category.id))}>{collapsed ? t('organize.menu.expand') : t('organize.menu.collapse')}</MenuItem>
            {isAdmin && (
              <>
                <div className="org-sep" role="separator" />
                <MenuItem onClick={() => { onCreateChannel(); onClose() }}>{t('organize.menu.createHere')}</MenuItem>
                <MenuItem onClick={() => { onRename(); onClose() }}>{t('organize.menu.renameCategory')}</MenuItem>
                {up && <MenuItem onClick={run(() => moveCategory(server.key, category.id, up.before))}>{t('organize.menu.moveUp')}</MenuItem>}
                {down && <MenuItem onClick={run(() => moveCategory(server.key, category.id, down.before))}>{t('organize.menu.moveDown')}</MenuItem>}
                <MenuItem danger onClick={() => setView('delete')}>{t('organize.menu.deleteCategory')}</MenuItem>
              </>
            )}
          </div>
        </>
      )}
      {error && <p className="error-text sheet-error" role="alert">{error}</p>}
    </OrgMenu>
  )
}
