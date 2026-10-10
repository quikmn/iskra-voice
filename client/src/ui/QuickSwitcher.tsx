// Ctrl/Cmd+K: jump to any channel or conversation by typing a few letters.
import { useEffect, useMemo, useRef, useState } from 'react'
import { nameOf, openConversation, openFriends, useDms } from '../state/dms'
import { selectChannel, selectServer, useApp } from '../state/store'
import { setStageOpen } from '../state/voice'
import { Avatar } from './bits'
import { Hash, Search, Users } from './icons'
import { useEscapeLayer, useFocusTrap } from './layers'
import { rankItems, type SwitchItem } from './quickSwitch'

export function QuickSwitcher() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return open ? <SwitcherDialog onClose={() => setOpen(false)} /> : null
}

function SwitcherDialog({ onClose }: { onClose: () => void }) {
  const servers = useApp((s) => s.servers)
  const order = useApp((s) => s.order)
  const conversations = useDms((s) => s.conversations)
  const friends = useDms((s) => s.friends)
  const [query, setQuery] = useState('')
  const [pick, setPick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEscapeLayer(onClose)
  useFocusTrap(ref)

  const items = useMemo<SwitchItem[]>(() => {
    const list: SwitchItem[] = []
    for (const peer of new Set([...Object.keys(conversations), ...Object.keys(friends)])) {
      list.push({ id: `dm:${peer}`, kind: 'dm', label: nameOf(peer), context: 'Direct message', unread: conversations[peer]?.unread ?? 0 })
    }
    for (const key of order) {
      const server = servers[key]
      if (!server) continue
      for (const channel of server.channels) {
        if (channel.kind !== 'text') continue
        list.push({ id: `ch:${key}:${channel.id}`, kind: 'channel', label: channel.name, context: server.name, unread: server.unread[channel.id] ?? 0 })
      }
    }
    list.push({ id: 'friends', kind: 'friends', label: 'Friends', context: 'Direct messages', unread: 0 })
    return list
  }, [servers, order, conversations, friends])
  const shown = rankItems(items, query)
  const active = shown.length ? pick % shown.length : 0

  function go(item: SwitchItem) {
    onClose()
    if (item.kind === 'friends') return openFriends()
    if (item.kind === 'dm') return openConversation(item.id.slice(3))
    const [, key, id] = item.id.split(':')
    selectServer(key)
    selectChannel(key, Number(id))
    setStageOpen(false)
  }

  return (
    <div className="modal-backdrop switcher-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal switcher" role="dialog" aria-modal="true" aria-label="Jump to a conversation" ref={ref} tabIndex={-1}>
        <label className="switcher-search">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            placeholder="Where to? Type a channel or a name"
            aria-label="Search channels and conversations"
            role="combobox"
            aria-expanded
            aria-controls="switcher-results"
            aria-activedescendant={shown[active] ? `switch-${active}` : undefined}
            onChange={(e) => { setQuery(e.target.value); setPick(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % Math.max(1, shown.length))
              } else if (e.key === 'Enter' && shown[active]) {
                e.preventDefault()
                go(shown[active])
              }
            }}
          />
        </label>
        <ul className="switcher-results" id="switcher-results" role="listbox" aria-label="Results">
          {shown.length === 0 && <li className="switcher-empty muted">Nothing matches “{query.trim()}”.</li>}
          {shown.map((item, i) => (
            <li
              key={item.id}
              id={`switch-${i}`}
              role="option"
              aria-selected={i === active}
              className={`switcher-item ${i === active ? 'active' : ''} ${item.unread ? 'unread' : ''}`}
              onMouseMove={() => setPick(i)}
              onClick={() => go(item)}
            >
              <span className="switcher-icon">
                {item.kind === 'channel' ? <Hash size={16} /> : item.kind === 'dm' ? <Avatar name={item.label} accountKey={item.id.slice(3)} size={20} /> : <Users size={16} />}
              </span>
              <span className="switcher-label">{item.label}</span>
              <span className="switcher-context">{item.context}</span>
              {item.unread > 0 && <span className="badge">{item.unread > 99 ? '99+' : item.unread}</span>}
            </li>
          ))}
        </ul>
        <footer className="switcher-hint muted">
          <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span> <span><kbd>Enter</kbd> to open</span> <span><kbd>Esc</kbd> to close</span>
        </footer>
      </div>
    </div>
  )
}
