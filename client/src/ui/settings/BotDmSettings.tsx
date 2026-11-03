// My settings → Privacy & data: whether bots on your servers may send you DMs (state/botDms.ts keeps it in step everywhere).
import { useTranslation } from 'react-i18next'
import { setBotDms, useBotDms } from '../../state/botDms'
import { SwitchRow } from '../kit'

export function BotDmSettings() {
  const { t } = useTranslation()
  const allow = useBotDms((s) => s.allow)
  return (
    <section className="settings-section" data-testid="bot-dm-settings">
      <h2>{t('dms.bot.settingTitle')}</h2>
      <SwitchRow title={t('dms.bot.settingLabel')} help={t('dms.bot.settingHint')} checked={allow} onChange={(on) => void setBotDms(on)} />
    </section>
  )
}
