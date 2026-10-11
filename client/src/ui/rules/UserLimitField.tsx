// Voice channel settings: how many people fit (0 = no limit), like Discord's user limit.
import { useTranslation } from 'react-i18next'
import { MAX_USER_LIMIT, clampLimit } from '../../state/voiceRulesLogic'
import './rules.css'

export function UserLimitField({ value, onChange }: { value: number; onChange: (limit: number) => void }) {
  const { t } = useTranslation()
  return (
    <label className="field user-limit-field">
      <span>{value ? t('rules.userLimit.people', { count: value }) : t('rules.userLimit.none')}</span>
      <input type="range" min={0} max={MAX_USER_LIMIT} step={1} aria-label={t('rules.userLimit.label')} value={value}
        onChange={(e) => onChange(clampLimit(Number(e.target.value)))} />
      <small className="muted">{t('rules.userLimit.hint')}</small>
    </label>
  )
}
