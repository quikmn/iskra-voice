// Streamer mode in the UI: the pill that says it's on, values kept off the stream, the switch in My settings and the
// quick toggle in the status menu. The rules are in state/streamer.ts.
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop } from '../../platform/desktop'
import { setStreamerMode, useStreamer, useStreamerMode } from '../../state/streamer'
import { maskEmails, maskSecret } from '../../state/streamerLogic'
import { openMySettings } from '../settings/open'
import './streamer.css'

/** "Streamer mode", while it's on. `floating`: the main window's corner pill; otherwise inline (pop-outs, captions). */
export function StreamerPill({ floating = false }: { floating?: boolean }) {
  const { t } = useTranslation()
  const on = useStreamerMode()
  if (!on) return null
  return (
    <button className={`streamer-pill ${floating ? 'floating' : ''}`} onClick={() => openMySettings('streamer')} title={t('streamer.pillHint')} data-testid="streamer-pill">
      {t('streamer.pill')}
    </button>
  )
}

/**
 * A value that stays off the stream (an invite link or code, an account id): dots while streamer mode is on.
 * `title` and `prefix` are shown only with the real value.
 */
export function Secret({ value, title, prefix }: { value: string; title?: string; prefix?: string }) {
  const { t } = useTranslation()
  const on = useStreamerMode()
  if (!on) return <span title={title}>{prefix}{value}</span>
  return <span className="streamer-hidden" title={t('streamer.hidden')} aria-label={t('streamer.hidden')} data-testid="streamer-hidden">{maskSecret(value)}</span>
}

/** Free text that may hold email addresses (a bio): rendered through `render`, with the addresses masked while streaming. */
export function EmailSafe({ text, render }: { text: string; render: (text: string) => ReactNode }) {
  const on = useStreamerMode()
  return <>{render(on ? maskEmails(text) : text)}</>
}

/** Status menu: the quick toggle. While the desktop app holds it on, it leads to the settings instead. */
export function StreamerStatusRow({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const manual = useStreamer((s) => s.pref.on)
  const autoOn = useStreamer((s) => s.autoOn)
  const on = manual || autoOn
  const held = autoOn && !manual
  return (
    <button
      className={`status-quiet status-streamer ${on ? 'active' : ''}`} role="menuitemcheckbox" aria-checked={on} data-testid="streamer-toggle"
      onClick={() => { onClose(); if (held) openMySettings('streamer'); else setStreamerMode(!manual) }}
    >
      <span className="status-streamer-dot" aria-hidden>●</span>
      <span>{on ? t('streamer.menu.on') : t('streamer.menu.off')}</span>
      <span className="muted">{held ? t('streamer.menu.autoOn') : manual ? t('streamer.menu.turnOff') : t('streamer.menu.turnOn')}</span>
    </button>
  )
}

/** My settings → Streamer mode. */
export function StreamerSection() {
  const { t } = useTranslation()
  const manual = useStreamer((s) => s.pref.on)
  const autoOn = useStreamer((s) => s.autoOn)
  return (
    <section className="settings-section" data-testid="streamer-section">
      <h2>{t('streamer.title')}</h2>
      <label className="checkbox">
        <input type="checkbox" checked={manual} onChange={(e) => setStreamerMode(e.target.checked)} />
        <span>
          {t('streamer.switch')}
          <br /><small className="muted">{t('streamer.switchHint')}</small>
        </span>
      </label>
      {autoOn && <p className="muted" role="status">{t('streamer.autoNow')}</p>}
      {desktop && (
        <p className="muted">
          {t('streamer.autoDesktopOnly')} <button className="link" onClick={() => openMySettings('desktop')}>{t('settings.sections.desktop')}</button>
        </p>
      )}
    </section>
  )
}
