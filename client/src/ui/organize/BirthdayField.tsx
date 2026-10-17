// Your profile on this server: your birthday for the Birthdays bot (day and month, never a year). Shown while the bot
// is on, or while you still have one saved there (so you can always remove it).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Birthday } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { useBuiltinBots } from '../../state/builtinBots'
import { getBirthday, setBirthday } from '../../state/moreBuiltinBots'
import { daysIn, monthNames } from '../../state/moreBuiltinBotsLogic'
import type { ServerState } from '../../state/store'
import '../moreBots.css'

export function BirthdayField({ server }: { server: ServerState }) {
  const { t, i18n } = useTranslation()
  const on = useBuiltinBots((s) => !!s.bots[server.key]?.find((b) => b.id === 'birthdays')?.enabled)
  const [saved, setSaved] = useState<Birthday | null | undefined>(undefined)
  const [month, setMonth] = useState(0)
  const [day, setDay] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let live = true
    getBirthday(server.key).then((b) => {
      if (!live) return
      setSaved(b)
      setMonth(b?.month ?? 0)
      setDay(b?.day ?? 0)
    }, () => live && setSaved(null))
    return () => { live = false }
  }, [server.key])

  if (saved === undefined || (!on && !saved)) return null
  const months = monthNames(i18n.language)
  const max = month ? daysIn(month) : 31
  const valid = month >= 1 && day >= 1 && day <= max
  const changed = !saved || saved.month !== month || saved.day !== day

  async function apply(birthday: Birthday | null) {
    setBusy(true)
    setStatus(null)
    try {
      const result = await setBirthday(server.key, birthday)
      setSaved(result)
      if (!result) {
        setMonth(0)
        setDay(0)
      }
      setStatus({ kind: 'saved', text: result ? t('moreBots.profile.saved') : t('moreBots.profile.removed') })
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="org-birthday" data-testid="birthday-field">
      <span className="field-label">{t('moreBots.profile.label')}</span>
      <div className="org-birthday-row">
        <select aria-label={t('moreBots.profile.day')} value={day} disabled={busy} onChange={(e) => { setDay(Number(e.target.value)); setStatus(null) }}>
          <option value={0}>{t('moreBots.profile.day')}</option>
          {Array.from({ length: max }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
        </select>
        <select aria-label={t('moreBots.profile.month')} value={month} disabled={busy}
          onChange={(e) => {
            const m = Number(e.target.value)
            setMonth(m)
            if (m && day > daysIn(m)) setDay(daysIn(m))
            setStatus(null)
          }}>
          <option value={0}>{t('moreBots.profile.month')}</option>
          {months.map((name, i) => <option key={i + 1} value={i + 1}>{name}</option>)}
        </select>
        {on && <button className="button small" disabled={busy || !valid || !changed} onClick={() => void apply({ month, day })}>{t('moreBots.profile.save')}</button>}
        {saved && <button className="button small danger-outline" disabled={busy} onClick={() => void apply(null)}>{t('common.remove')}</button>}
      </div>
      <p className={status?.kind === 'error' ? 'error-text' : 'muted'} role={status ? 'status' : undefined}>{status ? status.text : t('moreBots.profile.hint')}</p>
    </div>
  )
}
