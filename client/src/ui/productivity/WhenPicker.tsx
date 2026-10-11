// Picking a time: a few quick choices, or any date and time (to the second).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParseKeys } from 'i18next'
import { formatDate } from '../../i18n/format'
import { fromLocalInput, presetTime, timeProblem, toLocalInput, type Preset } from '../../state/productivityLogic'

/** "Mon 13 Oct, 09:00" in the app's language. */
export const whenText = (ms: number) =>
  formatDate(ms, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const LABELS: Record<Preset, ParseKeys> = {
  '20m': 'productivity.when.in20m',
  '1h': 'productivity.when.in1h',
  '3h': 'productivity.when.in3h',
  tomorrow: 'productivity.when.tomorrow',
  nextWeek: 'productivity.when.nextWeek',
}

/**
 * Quick choices call `onPick` at once; "Pick a date and time" opens a field whose value goes to `onCustom` as it
 * changes (null while it isn't a usable time).
 */
export function WhenPicker({ presets, maxAheadMs, onPick, onCustom, initial }: {
  presets: Preset[]
  maxAheadMs: number
  onPick: (at: number) => void
  onCustom: (at: number | null) => void
  initial?: number
}) {
  const { t } = useTranslation()
  const [custom, setCustom] = useState(initial !== undefined)
  const [value, setValue] = useState(() => toLocalInput(initial ?? presetTime('1h', new Date())))
  const problem = custom ? timeProblem(fromLocalInput(value), Date.now(), maxAheadMs) : null

  const change = (next: string) => {
    setValue(next)
    const at = fromLocalInput(next)
    onCustom(timeProblem(at, Date.now(), maxAheadMs) ? null : at)
  }
  // Opened on a given time: the parent gets it right away.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initial !== undefined) change(value) }, [])

  return (
    <div className="when-picker">
      <div className="when-presets" role="group">
        {presets.map((p) => (
          <button key={p} type="button" className="when-preset" onClick={() => onPick(presetTime(p, new Date()))}>
            <span>{t(LABELS[p])}</span>
            <span className="muted">{whenText(presetTime(p, new Date()))}</span>
          </button>
        ))}
        <button type="button" className={`when-preset ${custom ? 'on' : ''}`} aria-expanded={custom} onClick={() => {
          setCustom(true)
          change(value)
        }}>
          <span>{t('productivity.when.custom')}</span>
        </button>
      </div>
      {custom && (
        <label className="field when-custom">
          <span>{t('productivity.when.customLabel')}</span>
          <input type="datetime-local" step={1} value={value} onChange={(e) => change(e.target.value)} autoFocus data-testid="when-custom" />
          {problem && <small className="error-text">{t(`productivity.when.${problem}`)}</small>}
        </label>
      )}
    </div>
  )
}
