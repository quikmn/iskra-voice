// Server settings → Translation (owner): offer translation models to members, with what each language weighs.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TranslateConfig } from '../../core/protocol'
import { formatBytes } from '../../i18n/format'
import { errorMessage } from '../../i18n/errors'
import { intlLocale } from '../../i18n'
import { connectionFor, type ServerState } from '../../state/store'
import { languageName, modelBytes, PINS, PIVOT, TRANSLATE_LANGUAGES } from '../../state/translate/languages'
import { Spinner } from '../bits'
import './translate.css'

const ALL_BYTES = modelBytes(PINS.map((p) => p.name))

export function TranslateServerSection({ server }: { server: ServerState }) {
  const { t, i18n } = useTranslation()
  const [config, setConfig] = useState<TranslateConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const locale = intlLocale()

  useEffect(() => {
    connectionFor(server.key)?.request('translate.config', {}).then(setConfig).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function offer(on: boolean) {
    const before = config
    setBusy(true)
    setError(null)
    setConfig((c) => (c ? { ...c, offer: on } : c))
    try {
      const next = await connectionFor(server.key)?.request('translate.configure', { offer: on })
      if (next) setConfig(next)
    } catch (e) {
      setConfig(before)
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onServer = (language: string) => {
    const pairs = [`${PIVOT}-${language}`, `${language}-${PIVOT}`]
    return pairs.every((p) => config?.downloaded.includes(p))
  }

  return (
    <section className="settings-section translate-server" data-testid="translate-section" lang={i18n.language}>
      <h2>{t('settings.sections.translate')}</h2>
      <p className="muted">{t('translate.server.intro')}</p>
      {!config ? (
        error ? <p className="error-text" role="alert">{error}</p> : <Spinner />
      ) : (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={config.offer} disabled={busy} onChange={(e) => void offer(e.target.checked)} />
            {t('translate.server.offer')}
          </label>
          <p className="muted small">{t('translate.server.offerHint')}</p>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="translate-table-wrap">
            <table className="translate-table">
              <thead>
                <tr>
                  <th scope="col">{t('translate.server.language')}</th>
                  <th scope="col">{t('translate.server.size')}</th>
                  <th scope="col">{t('translate.server.onServer')}</th>
                </tr>
              </thead>
              <tbody>
                {TRANSLATE_LANGUAGES.filter((l) => l !== PIVOT).map((language) => (
                  <tr key={language}>
                    <td>{languageName(language, locale)}</td>
                    <td>{formatBytes(modelBytes([`${PIVOT}-${language}`]))} · {formatBytes(modelBytes([`${language}-${PIVOT}`]))}</td>
                    <td>{onServer(language) ? t('translate.server.yes') : t('translate.server.notYet')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">{t('translate.server.total', { size: formatBytes(ALL_BYTES) })}</p>
        </>
      )}
    </section>
  )
}
