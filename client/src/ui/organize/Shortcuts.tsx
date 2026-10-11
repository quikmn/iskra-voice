// Keyboard shortcuts: unread navigation and marking read, plus the list of every shortcut (Ctrl+/).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useVoice } from '../../state/voice'
import { goToUnread, markAllRead, markOpenRead } from '../../state/unread'
import { openLayers } from '../layers'
import { Modal } from '../bits'
import './organize.css'

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = mac ? '⌘' : 'Ctrl'
const ALT = mac ? '⌥' : 'Alt'

function shortcutList(t: TFunction, pttKey: string | null): { group: string; items: [string[], string][] }[] {
  return [
    {
      group: t('organize.shortcuts.gettingAround'),
      items: [
        [[MOD, 'K'], t('organize.shortcuts.jump')],
        [[ALT, '↑'], t('organize.shortcuts.prevUnread')],
        [[ALT, '↓'], t('organize.shortcuts.nextUnread')],
        [['Esc'], t('organize.shortcuts.markRead')],
        [['Shift', 'Esc'], t('organize.shortcuts.markServerRead')],
        [[MOD, '/'], t('organize.shortcuts.show')],
      ],
    },
    {
      group: t('organize.shortcuts.writing'),
      items: [
        [['Enter'], t('organize.shortcuts.send')],
        [['Shift', 'Enter'], t('organize.shortcuts.newLine')],
        [['↑'], t('organize.shortcuts.editLast')],
        [['Enter'], t('organize.shortcuts.saveEdit')],
        [['Esc'], t('organize.shortcuts.cancelEdit')],
        [['@'], t('organize.shortcuts.mention')],
        [[':'], t('organize.shortcuts.emoji')],
      ],
    },
    {
      group: t('organize.shortcuts.voice'),
      items: [[[pttKey ?? t('organize.shortcuts.notSet')], pttKey ? t('organize.shortcuts.ptt') : t('organize.shortcuts.pttUnset')]],
    },
  ]
}

export function Shortcuts() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault()
        setOpen((o) => !o)
        return
      }
      if (e.defaultPrevented || openLayers() > 0) return
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (goToUnread(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        if (e.shiftKey) markAllRead()
        else markOpenRead()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const ptt = useVoice((s) => (s.settings.mode === 'ptt' ? (s.settings.desktopKey ?? s.settings.webKey)?.label ?? null : null))
  if (!open) return null
  return (
    <Modal title={t('organize.shortcuts.title')} onClose={() => setOpen(false)} wide>
      <div className="shortcut-groups">
        {shortcutList(t, ptt).map(({ group, items }) => (
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
      <p className="muted">{t('organize.shortcuts.more')}</p>
    </Modal>
  )
}
