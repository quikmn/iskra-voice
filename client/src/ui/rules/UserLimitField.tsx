// Voice channel settings: how many people fit (0 = no limit), like Discord's user limit.
import { MAX_USER_LIMIT, clampLimit } from '../../state/voiceRulesLogic'
import './rules.css'

export function UserLimitField({ value, onChange }: { value: number; onChange: (limit: number) => void }) {
  return (
    <label className="field user-limit-field">
      <span>User limit · {value ? `${value} ${value === 1 ? 'person' : 'people'}` : 'no limit'}</span>
      <input type="range" min={0} max={MAX_USER_LIMIT} step={1} aria-label="User limit" value={value}
        onChange={(e) => onChange(clampLimit(Number(e.target.value)))} />
      <small className="muted">When it's full, others can't join. People who can move members still can.</small>
    </label>
  )
}
