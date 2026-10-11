// What you can do with a channel or a category: notifications and mutes for everyone, arranging for admins.
import { useState } from 'react'
import type { Category, Channel, NotifyLevel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { markChannelRead, useChannelCounts } from '../../state/unread'
import {
  deleteCategory, moveCategory, moveChannel, muteFor, setNotifyLevel, toggleCollapsed, useCategories, useNotifyFor, useOrganize,
} from '../../state/organize'
import {
  LEVEL_LABELS, MUTE_CHOICES, layoutChannels, muteLabel, notifyKey, stepCategory, stepChannel,
} from '../../state/organizeLogic'
import { MenuItem, MenuTitle, OrgMenu, type MenuAnchor } from './OrgMenu'

type Run = (action: () => Promise<unknown> | void) => () => void

function useRunner(onClose: () => void): [Run, string | null] {
  const [error, setError] = useState<string | null>(null)
  const run: Run = (action) => () => {
    void (async () => {
      try {
        await action()
        onClose()
      } catch (e) {
        setError((e as Error).message)
      }
    })()
  }
  return [run, error]
}

/** The level picker and mute choices for the server (channelId null) or one channel. */
function NotifyViews({ server, channelId, view, setView, run }: {
  server: ServerState
  channelId: number | null
  view: 'levels' | 'mute'
  setView: (v: 'menu') => void
  run: Run
}) {
  const own = useOrganize((s) => s.notify[server.key]?.[notifyKey(channelId)])
  const serverLevel = useNotifyFor(server.key, null).chosen
  const where = channelId === null ? 'server' : 'channel'
  if (view === 'levels') {
    const current = own?.level ?? 'default'
    const pick = (level: NotifyLevel | 'default') => run(() => setNotifyLevel(server.key, channelId, level))
    return (
      <>
        <MenuTitle onBack={() => setView('menu')}>Notify me about</MenuTitle>
        <div className="org-list" role="menu">
          {channelId !== null && (
            <MenuItem checked={current === 'default'} onClick={pick('default')} hint={LEVEL_LABELS[serverLevel]}>Server default</MenuItem>
          )}
          {(['all', 'mentions', 'none'] as const).map((level) => (
            <MenuItem key={level} checked={current === level || (channelId === null && current === 'default' && level === 'mentions')} onClick={pick(level)}>
              {LEVEL_LABELS[level]}
            </MenuItem>
          ))}
        </div>
      </>
    )
  }
  return (
    <>
      <MenuTitle onBack={() => setView('menu')}>Mute this {where}</MenuTitle>
      <div className="org-list" role="menu">
        {MUTE_CHOICES.map((choice) => (
          <MenuItem key={choice.minutes} onClick={run(() => muteFor(server.key, channelId, choice.minutes))}>{choice.label}</MenuItem>
        ))}
      </div>
    </>
  )
}

/** Notification rows shared by the channel menu and the server's notification settings. */
function NotifyRows({ server, channelId, setView, run }: { server: ServerState; channelId: number | null; setView: (v: 'levels' | 'mute') => void; run: Run }) {
  const notify = useNotifyFor(server.key, channelId)
  const own = useOrganize((s) => s.notify[server.key]?.[notifyKey(channelId)])
  const clock = useOrganize((s) => s.clock)
  const ownMuted = muteLabel(own?.mutedUntil ?? null, clock)
  const where = channelId === null ? 'server' : 'channel'
  return (
    <>
      <MenuItem onClick={() => setView('levels')} hint={LEVEL_LABELS[notify.chosen]}>Notifications</MenuItem>
      {ownMuted ? (
        <MenuItem onClick={run(() => muteFor(server.key, channelId, 0))} hint={ownMuted}>Unmute {where}</MenuItem>
      ) : (
        <MenuItem onClick={() => setView('mute')} hint={notify.muted ? 'Server is muted' : undefined}>Mute {where}</MenuItem>
      )}
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
  const [view, setView] = useState<'menu' | 'levels' | 'mute' | 'move'>('menu')
  const [run, error] = useRunner(onClose)
  const categories = useCategories(server.key)
  const layout = layoutChannels(server.channels, categories)
  const up = stepChannel(layout, channel, -1)
  const down = stepChannel(layout, channel, 1)
  const counts = useChannelCounts(server.key, channel)
  const unread = counts.unread + counts.mentions
  const label = channel.kind === 'voice' ? channel.name : `#${channel.name}`

  return (
    <OrgMenu anchor={anchor} label={`${label} options`} onClose={onClose}>
      {view === 'levels' || view === 'mute' ? (
        <NotifyViews server={server} channelId={channel.id} view={view} setView={setView} run={run} />
      ) : view === 'move' ? (
        <>
          <MenuTitle onBack={() => setView('menu')}>Move {label} to</MenuTitle>
          <div className="org-list" role="menu">
            <MenuItem checked={channel.categoryId == null} onClick={run(() => moveChannel(server.key, channel.id, null, null))}>No category</MenuItem>
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
                Mark as read
              </MenuItem>
            )}
            {channel.kind === 'text' && <NotifyRows server={server} channelId={channel.id} setView={setView} run={run} />}
            {isAdmin && (
              <>
                <div className="org-sep" role="separator" />
                {up && <MenuItem onClick={run(() => moveChannel(server.key, channel.id, up.categoryId, up.before))}>Move up</MenuItem>}
                {down && <MenuItem onClick={run(() => moveChannel(server.key, channel.id, down.categoryId, down.before))}>Move down</MenuItem>}
                <MenuItem onClick={() => setView('move')} hint={categories.find((c) => c.id === channel.categoryId)?.name ?? 'None'}>Move to category</MenuItem>
                <MenuItem onClick={() => { onEdit(); onClose() }}>Edit channel</MenuItem>
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
  const [view, setView] = useState<'menu' | 'delete'>('menu')
  const [run, error] = useRunner(onClose)
  const categories = useCategories(server.key)
  const collapsed = useOrganize((s) => (s.collapsed[server.key] ?? []).includes(category.id))
  const up = stepCategory(categories, category.id, -1)
  const down = stepCategory(categories, category.id, 1)
  return (
    <OrgMenu anchor={anchor} label={`${category.name} options`} onClose={onClose}>
      {view === 'delete' ? (
        <div className="sheet-confirm">
          <strong>Delete {category.name}?</strong>
          <p className="muted">Its channels stay, at the top of the list without a category.</p>
          <button className="button danger wide" onClick={run(() => deleteCategory(server.key, category.id))}>Delete category</button>
          <button className="button wide" onClick={() => setView('menu')}>Cancel</button>
        </div>
      ) : (
        <>
          <MenuTitle>{category.name}</MenuTitle>
          <div className="org-list" role="menu">
            <MenuItem onClick={run(() => toggleCollapsed(server.key, category.id))}>{collapsed ? 'Expand' : 'Collapse'}</MenuItem>
            {isAdmin && (
              <>
                <div className="org-sep" role="separator" />
                <MenuItem onClick={() => { onCreateChannel(); onClose() }}>Create channel here</MenuItem>
                <MenuItem onClick={() => { onRename(); onClose() }}>Rename category</MenuItem>
                {up && <MenuItem onClick={run(() => moveCategory(server.key, category.id, up.before))}>Move up</MenuItem>}
                {down && <MenuItem onClick={run(() => moveCategory(server.key, category.id, down.before))}>Move down</MenuItem>}
                <MenuItem danger onClick={() => setView('delete')}>Delete category</MenuItem>
              </>
            )}
          </div>
        </>
      )}
      {error && <p className="error-text sheet-error" role="alert">{error}</p>}
    </OrgMenu>
  )
}
