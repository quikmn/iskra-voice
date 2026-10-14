// My settings → Privacy & data: whether bots on your servers may send you DMs (state/botDms.ts keeps it in step everywhere).
import { useTranslation } from 'react-i18next'
import { setBotDms, useBotDms } from '../../state/botDms'

export function BotDmSettings() {
  const { t } = useTranslation()
  const allow = useBotDms((s) => s.allow)
  return (
    <section className="settings-section" data-testid="bot-dm-settings">
      <h2>{t('dms.bot.settingTitle')}</h2>
      <label className="checkbox">
        <input type="checkbox" checked={allow} onChange={(e) => void setBotDms(e.target.checked)} />
        {t('dms.bot.settingLabel')}
      </label>
      <p className="muted">{t('dms.bot.settingHint')}</p>
    </section>
  )
}
