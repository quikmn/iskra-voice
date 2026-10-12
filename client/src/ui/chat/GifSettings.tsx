// GIF settings: the admin's KLIPY key and mode (Settings → Overview), and each viewer's auto-load choice (Appearance).
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { roleRank, type GifMode } from '../../core/protocol'
import { configureGifs, setGifAutoLoad, useGifs, useGifStatus } from '../../state/gifs'
import type { ServerState } from '../../state/store'
import { LINKS } from '../../links'
import './gifs.css'

export function GifSettings({ server }: { server: ServerState }) {
  const status = useGifStatus(server.key)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const { t } = useTranslation()
  if (!server.me || roleRank(server.me.role) < roleRank('admin')) return null
  const enabled = !!status?.enabled
  const mode: GifMode = status?.mode ?? 'proxy'

  async function save(change: { key?: string; mode?: GifMode }, done: string) {
    setBusy(true)
    setMessage(null)
    try {
      await configureGifs(server.key, change)
      if (change.key !== undefined) setKey('')
      setMessage({ error: false, text: done })
    } catch (e) {
      setMessage({ error: true, text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-subsection gif-settings">
      <h3 className="h4">{t('chat.gifSettings.title')}</h3>
      <p className="muted">
        {t('chat.gifSettings.intro')} <a href={LINKS.gifsGuide} target="_blank" rel="noopener noreferrer">{t('chat.gifSettings.howToGetKey')}</a>
      </p>
      <p><Trans i18nKey="chat.gifSettings.status" values={{ state: enabled ? t('common.on') : t('common.off') }} components={{ b: <strong /> }} /></p>
      <div className="copy-row">
        <input
          type="password"
          autoComplete="off"
          value={key}
          placeholder={enabled ? t('chat.gifSettings.replacePlaceholder') : t('chat.gifSettings.keyLabel')}
          aria-label={t('chat.gifSettings.keyLabel')}
          onChange={(e) => setKey(e.target.value.trim())}
          onKeyDown={(e) => e.key === 'Enter' && key && void save({ key }, t('chat.gifSettings.on'))}
        />
        <button className="button primary" disabled={busy || !key} onClick={() => void save({ key }, t('chat.gifSettings.on'))}>{enabled ? t('chat.gifSettings.replaceKey') : t('chat.gifSettings.turnOn')}</button>
        {enabled && <button className="button" disabled={busy} onClick={() => void save({ key: '' }, t('chat.gifSettings.off'))}>{t('chat.gifSettings.turnOff')}</button>}
      </div>

      <fieldset className="gif-mode" disabled={busy}>
        <legend>{t('chat.gifSettings.modeLegend')}</legend>
        <label className="radio">
          <input type="radio" name={`gif-mode-${server.key}`} checked={mode === 'proxy'} onChange={() => void save({ mode: 'proxy' }, t('chat.gifSettings.proxyDone'))} />
          <span>
            <span><Trans i18nKey="chat.gifSettings.proxyTitle" components={{ b: <strong /> }} /></span>
            <span className="muted">
              {t('chat.gifSettings.proxyBody')}
            </span>
          </span>
        </label>
        <label className="radio">
          <input type="radio" name={`gif-mode-${server.key}`} checked={mode === 'direct'} onChange={() => void save({ mode: 'direct' }, t('chat.gifSettings.directDone'))} />
          <span>
            <span><Trans i18nKey="chat.gifSettings.directTitle" components={{ b: <strong /> }} /></span>
            <span className="muted">
              <Trans i18nKey="chat.gifSettings.directBody" components={{ b: <strong /> }} />
            </span>
          </span>
        </label>
      </fieldset>
      {message && <p className={message.error ? 'error-text' : 'muted'} role="status">{message.text}</p>}
    </div>
  )
}

/** Settings → Appearance: whether GIFs that come straight from KLIPY load without a click. */
export function GifViewerSettings() {
  const autoLoad = useGifs((s) => s.autoLoad)
  const { t } = useTranslation()
  return (
    <section className="settings-section">
      <h2>{t('chat.gifSettings.viewerTitle')}</h2>
      <label className="checkbox">
        <input type="checkbox" checked={autoLoad} onChange={(e) => setGifAutoLoad(e.target.checked)} />
        {t('chat.gifSettings.autoLoad')}
      </label>
    </section>
  )
}
