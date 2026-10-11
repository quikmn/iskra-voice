// Keyboard shortcuts: unread navigation and marking read, plus the list of every shortcut (Ctrl+/).
import { useEffect, useState } from 'react'
import { activeChannelId, useApp } from '../../state/store'
import { useVoice } from '../../state/voice'
import { goToUnread, markChannelRead, markServerRead } from '../../state/unread'
import { openLayers } from '../layers'
import { Modal } from '../bits'
import './organize.css'

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = mac ? '⌘' : 'Ctrl'
const ALT = mac ? '⌥' : 'Alt'

function shortcutList(pttKey: string | null): { group: string; items: [string[], string][] }[] {
  return [
    {
      group: 'Getting around',
      items: [
        [[MOD, 'K'], 'Jump to a channel, person or server'],
        [[ALT, '↑'], 'Previous unread channel'],
        [[ALT, '↓'], 'Next unread channel'],
        [['Esc'], 'Mark this channel as read (or close what is open)'],
        [['Shift', 'Esc'], 'Mark the whole server as read'],
        [[MOD, '/'], 'Show these shortcuts'],
      ],
    },
    {
      group: 'Writing',
      items: [
        [['Enter'], 'Send'],
        [['Shift', 'Enter'], 'New line'],
        [['↑'], 'Edit your last message (in an empty message box)'],
        [['Enter'], 'Save an edit'],
        [['Esc'], 'Cancel an edit or a reply'],
        [['@'], 'Mention someone; ↑ ↓ to choose, Enter or Tab to pick'],
        [[':'], 'Emoji by name; ↑ ↓ to choose, Enter or Tab to pick'],
      ],
    },
    {
      group: 'Voice',
      items: [[[pttKey ?? 'Not set'], pttKey ? 'Push to talk (hold)' : 'Push to talk: pick a key in Settings → Voice & audio']],
    },
  ]
}

export function Shortcuts() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault()
        setOpen((o) => !o)
        return
      }
      if (e.defaultPrevented || openLayers() > 0) return
      const state = useApp.getState()
      const server = state.activeServer
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (goToUnread(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault()
        return
      }
      if (e.key === 'Escape' && server) {
        if (e.shiftKey) markServerRead(server)
        else {
          const channel = activeChannelId(state)
          if (channel !== null) markChannelRead(server, channel)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const ptt = useVoice((s) => (s.settings.mode === 'ptt' ? (s.settings.desktopKey ?? s.settings.webKey)?.label ?? null : null))
  if (!open) return null
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)} wide>
      <div className="shortcut-groups">
        {shortcutList(ptt).map(({ group, items }) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl className="shortcut-list">
              {items.map(([keys, what], i) => (
                <div key={i}>
                  <dt>{keys.map((k, j) => <kbd key={j}>{k}</kbd>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted">Right-click a channel, category or server (or press and hold on a phone) for more.</p>
    </Modal>
  )
}
