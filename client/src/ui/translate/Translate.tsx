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
import './translate.css'

type Wrap = (doneLabel: string | null, action: () => void | Promise<unknown>) => () => void

const name = (code: string | undefined) => (code ? languageName(code, intlLocale()) : '')

const TranslateIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
  </svg>
)

/** "Translate" (or "Show original") for a message menu; `wrap` is the menu's own click wrapper. */
export function TranslateMenuItem({ item, wrap, icon }: { item: TranslateItem | null; wrap: Wrap; icon?: boolean }) {
  const { t } = useTranslation()
  const { key, entry } = useMessageTranslation(item)
  if (!item) return null
  const showing = entry?.shown && entry.status === 'done'
  return (
    <button role="menuitem" onClick={wrap(null, () => (showing ? hideTranslation(key) : translateMessage(item)))}>
      {icon && <TranslateIcon />} {showing ? t('translate.showOriginal') : t('translate.menu')}
    </button>
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

/** Header button: auto-translate here, and into which language. */
export function AutoTranslateButton({ conv }: { conv: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const auto = useAutoTranslate(conv)
  return (
    <div className="header-tools translate-tools">
      <button className={`icon-button ${open || auto ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} aria-label={t('translate.auto.button')}
        title={t('translate.auto.button')} aria-expanded={open} data-testid="auto-translate-button">
        <TranslateIcon />
      </button>
      {open && (
        <Popover title={t('translate.auto.title')} onClose={() => setOpen(false)}>
          <div className="translate-popover">
            <label className="checkbox">
              <input type="checkbox" checked={auto} onChange={(e) => setAutoTranslate(conv, e.target.checked)} />
              {t('translate.auto.toggle')}
            </label>
            <TranslateTargetField />
            <p className="muted small">{t('translate.auto.hint')}</p>
          </div>
        </Popover>
      )}
    </div>
  )
}
