// Settings → Limits (owner): upload size, daily allowances and soundboard/emoji/sticker limits. Saved to server.json, live at once.
import { useEffect, useState } from 'react'
import type { ServerLimits } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { Spinner } from '../bits'

type Key = keyof ServerLimits

const FIELDS: { key: Key; label: string; unit: string; hint: string; min: number }[] = [
  { key: 'maxUploadMb', label: 'Largest upload', unit: 'MB', hint: 'Any file anyone sends.', min: 1 },
  { key: 'memberMbPerDay', label: 'Daily uploads per member', unit: 'MB', hint: '0 = no limit. Admins and the owner are never limited.', min: 0 },
  { key: 'guestMbPerDay', label: 'Daily uploads per guest', unit: 'MB', hint: '0 = no limit.', min: 0 },
  { key: 'soundMaxSeconds', label: 'Longest soundboard sound', unit: 'seconds', hint: '0 = no limit.', min: 0 },
  { key: 'soundMaxMb', label: 'Largest soundboard sound', unit: 'MB', hint: '0 = no limit beyond the largest upload.', min: 0 },
  { key: 'emojiMaxKb', label: 'Largest emoji', unit: 'KB', hint: '0 = no limit beyond the largest upload.', min: 0 },
  { key: 'stickerMaxKb', label: 'Largest sticker', unit: 'KB', hint: '0 = no limit beyond the largest upload.', min: 0 },
]

export function LimitsSection({ server }: { server: ServerState }) {
  const [limits, setLimits] = useState<ServerLimits | null>(null)
  const [draft, setDraft] = useState<Partial<Record<Key, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    connectionFor(server.key)?.request('limits.get', {}).then(setLimits).catch((e: Error) => setError(e.message))
  }, [server.key])

  async function save(key: Key) {
    const raw = draft[key]
    if (raw === undefined || !limits) return
    const value = Number(raw)
    const field = FIELDS.find((f) => f.key === key)!
    if (!Number.isInteger(value) || value < field.min) {
      setError(`${field.label}: use a whole number${field.min ? ` of at least ${field.min}` : ''}.`)
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
      setError((e as Error).message)
    }
  }

  return (
    <section className="settings-section limits" data-testid="limits-section">
      <h3>Limits</h3>
      <p className="muted">How big uploads and expressions can be on this server. Changes apply right away and are saved in server.json.</p>
      {!limits ? (
        error ? <p className="error-text">{error}</p> : <Spinner />
      ) : (
        <div className="limits-grid">
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <div className="limits-input">
                <input
                  type="number"
                  inputMode="numeric"
                  min={f.min}
                  step={1}
                  aria-label={f.label}
                  value={draft[f.key] ?? String(limits[f.key])}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  onBlur={() => void save(f.key)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
                <span className="muted">{f.unit}</span>
              </div>
              <small className="muted">{f.hint}</small>
            </label>
          ))}
        </div>
      )}
      {saved && <p className="muted" role="status">Saved.</p>}
      {limits && error && <p className="error-text">{error}</p>}
    </section>
  )
}
