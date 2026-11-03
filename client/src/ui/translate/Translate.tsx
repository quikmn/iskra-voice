// Message translation in the UI: "Translate" in message menus, the translation under a message, and the header
// button for auto-translate and the language to translate into. Translations are plain text rendered by React.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../../i18n/format'
import { intlLocale } from '../../i18n'
import {
  approveTranslationDownload, hideTranslation, onPhone, setAutoTranslate, setTranslateTarget, translateMessage, translateTarget,
  useAutoTranslate, useMessageTranslation, useTranslate, type TranslateItem, type Translation,
} from '../../state/translate'
import { languageName, TRANSLATE_LANGUAGES } from '../../state/translate/languages'
import { Popover } from '../chat/HeaderTools'
import { MenuItem, SwitchRow } from '../kit'
import './translate.css'

type Wrap = (doneLabel: string | null, action: () => void | Promise<unknown>) => () => void

const name = (code: string | undefined) => (code ? languageName(code, intlLocale()) : '')

export const TranslateIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
  </svg>
)

/** "Translate" (or "Show original") for a message menu; `wrap` is the menu's own click wrapper. */
export function TranslateMenuItem({ item, wrap }: { item: TranslateItem | null; wrap: Wrap }) {
  const { t } = useTranslation()
  const { key, entry } = useMessageTranslation(item)
  if (!item) return null
  const showing = entry?.shown && entry.status === 'done'
  return (
    <MenuItem icon={<TranslateIcon />} onClick={wrap(null, () => (showing ? hideTranslation(key) : translateMessage(item)))}>
      {showing ? t('translate.showOriginal') : t('translate.menu')}
    </MenuItem>
  )
}

/** "Translate" / "Show original" as an icon button (the hover bar of DM and group messages). */
export function TranslateButton({ item }: { item: TranslateItem }) {
  const { t } = useTranslation()
  const { key, entry } = useMessageTranslation(item)
  const showing = entry?.shown && entry.status === 'done'
  const label = showing ? t('translate.showOriginal') : t('translate.menu')
  return (
    <button onClick={() => (showing ? hideTranslation(key) : translateMessage(item))} title={label} aria-label={label} aria-pressed={!!showing}>
      <TranslateIcon size={15} />
    </button>
  )
}

/** The translation (or what's happening with it) under a message; nothing when there's nothing to show. */
export function TranslationBlock({ item }: { item: TranslateItem | null }) {
  const { key, entry } = useMessageTranslation(item)
  if (!item || !entry?.shown) return null
  return <Block entryKey={key} entry={entry} item={item} />
}

function Block({ entryKey, entry, item }: { entryKey: string; entry: Translation; item: TranslateItem }) {
  const { t } = useTranslation()
  const close = <button className="link" onClick={() => hideTranslation(entryKey)}>{t('translate.showOriginal')}</button>
  switch (entry.status) {
    case 'done':
      return (
        <div className="translation done" data-testid="translation" lang={translateTarget()}>
          <p className="translation-text">{entry.text}</p>
          <div className="translation-meta">
            <TranslateIcon size={13} /> {t('translate.translatedFrom', { language: name(entry.from) })} · {close}
          </div>
        </div>
      )
    case 'detecting':
    case 'translating':
      return <div className="translation working" role="status">{t('translate.translating')}</div>
    case 'downloading':
      return (
        <div className="translation working" role="status">
          {t('translate.downloading', { size: formatBytes(entry.bytes ?? 0), percent: Math.round((entry.progress ?? 0) * 100) })}
          <progress max={1} value={entry.progress ?? 0} aria-hidden="true" />
        </div>
      )
    case 'needsDownload':
      return (
        <div className="translation notice" data-testid="translation-download">
          <p>{t('translate.needsDownload', { language: name(entry.from), size: formatBytes(entry.bytes ?? 0) })}{onPhone() && <> {t('translate.phoneWarning')}</>}</p>
          <div className="translation-actions">
            <button className="button small primary" onClick={() => approveTranslationDownload(entryKey)}>{t('translate.download')}</button>
            <button className="button small" onClick={() => hideTranslation(entryKey)}>{t('translate.notNow')}</button>
          </div>
        </div>
      )
    case 'failed':
    case 'corrupt':
      return (
        <div className="translation notice" role="alert">
          {t(entry.status === 'failed' ? 'translate.failed' : 'translate.corrupt')}{' '}
          <button className="link" onClick={() => translateMessage(item)}>{t('translate.retry')}</button> · {close}
        </div>
      )
    default: {
      const text = entry.status === 'same' ? t('translate.same', { language: name(entry.from) })
        : entry.status === 'unsupported' ? t('translate.unsupported', { language: name(entry.from) })
          : entry.status === 'notOffered' ? t('translate.notOffered')
            : entry.status === 'noEngine' ? t('translate.noEngine')
              : t('translate.unknown')
      return <div className="translation notice" data-testid="translation-notice">{text} · {close}</div>
    }
  }
}

/** The language messages are translated into: the app's own, or another. */
export function TranslateTargetField() {
  const { t } = useTranslation()
  const target = useTranslate((s) => s.settings.target)
  const locale = intlLocale()
  const app = name(translateTarget({ target: null, auto: [] }))
  return (
    <label className="field">
      <span>{t('translate.auto.into')}</span>
      <select value={target ?? ''} onChange={(e) => setTranslateTarget(e.target.value || null)}>
        <option value="">{t('translate.auto.appLanguage', { language: app })}</option>
        {TRANSLATE_LANGUAGES.map((code) => <option key={code} value={code} lang={code}>{languageName(code, locale)}</option>)}
      </select>
    </label>
  )
}

/**
 * Auto-translate here, and into which language, for a conversation header: an icon while it's on (it says so), else
 * a row in the header's "⋯". Both open the same popover.
 */
export function useAutoTranslateTool(conv: string) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const auto = useAutoTranslate(conv)
  return {
    on: auto,
    button: (
      <button className={`icon-button ${open || auto ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} aria-label={t('translate.auto.button')}
        title={t('translate.auto.button')} aria-expanded={open} data-testid="auto-translate-button">
        <TranslateIcon />
      </button>
    ),
    item: { key: 'translate', label: t('translate.auto.button'), icon: <TranslateIcon />, onSelect: () => setOpen(true), testId: 'auto-translate-item' },
    popover: open && (
      <Popover title={t('translate.auto.title')} onClose={() => setOpen(false)}>
        <div className="translate-popover">
          <SwitchRow title={t('translate.auto.toggle')} checked={auto} onChange={(on) => setAutoTranslate(conv, on)} />
          <TranslateTargetField />
          <p className="muted small">{t('translate.auto.hint')}</p>
        </div>
      </Popover>
    ),
  }
}
