// Settings → Limits (owner): upload size, daily allowances and soundboard/emoji/sticker limits. Saved to server.json, live at once.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { ServerLimits } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { Spinner } from '../bits'

type Key = keyof ServerLimits

/** Labels and hints are settings.limits.<key> and settings.limits.<key>Hint. */
const FIELDS: { key: Key; unit: 'MB' | 'KB' | 'seconds'; min: number }[] = [
  { key: 'maxUploadMb', unit: 'MB', min: 1 },
  { key: 'memberMbPerDay', unit: 'MB', min: 0 },
  { key: 'guestMbPerDay', unit: 'MB', min: 0 },
  { key: 'soundMaxSeconds', unit: 'seconds', min: 0 },
  { key: 'soundMaxMb', unit: 'MB', min: 0 },
  { key: 'emojiMaxKb', unit: 'KB', min: 0 },
  { key: 'stickerMaxKb', unit: 'KB', min: 0 },
]

export function LimitsSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const label = (key: Key) => t(`settings.limits.${key}`)
  const [limits, setLimits] = useState<ServerLimits | null>(null)
  const [draft, setDraft] = useState<Partial<Record<Key, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    connectionFor(server.key)?.request('limits.get', {}).then(setLimits).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function save(key: Key) {
    const raw = draft[key]
    if (raw === undefined || !limits) return
    const value = Number(raw)
    const field = FIELDS.find((f) => f.key === key)!
    if (!Number.isInteger(value) || value < field.min) {
      setError(field.min ? t('settings.limits.wholeNumberMin', { field: label(key), min: field.min }) : t('settings.limits.wholeNumber', { field: label(key) }))
      return
    }
    setError(null)
    try {
      const next = await connectionFor(server.key)?.request('limits.update', { [key]: value })
      if (next) setLimits(next)
      setDraft(({ [key]: _, ...rest }) => rest)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <section className="settings-section limits" data-testid="limits-section">
      <h2>{t('settings.sections.limits')}</h2>
      <p className="muted">{t('settings.limits.intro')}</p>
      {!limits ? (
        error ? <p className="error-text">{error}</p> : <Spinner />
      ) : (
        <div className="limits-grid">
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>{label(f.key)}</span>
              <div className="limits-input">
                <input
                  type="number"
                  inputMode="numeric"
                  min={f.min}
                  step={1}
                  aria-label={label(f.key)}
                  value={draft[f.key] ?? String(limits[f.key])}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  onBlur={() => void save(f.key)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
                <span className="muted">{f.unit === 'seconds' ? t('settings.limits.seconds') : f.unit}</span>
              </div>
              <small className="muted">{t(`settings.limits.${f.key}Hint`)}</small>
            </label>
          ))}
        </div>
      )}
      {saved && <p className="muted" role="status">{t('settings.limits.saved')}</p>}
      {limits && error && <p className="error-text">{error}</p>}
    </section>
  )
}
