// Server settings → Bots: the built-in bots (Dice, Polls, Reminders), each one click on or off. Admins only.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { roleRank, type BuiltinBotId } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { setBuiltinBot, useBuiltinBots } from '../../state/builtinBots'
import { BUILTIN_BOTS } from '../../state/builtinBotsLogic'
import type { ServerState } from '../../state/store'
import { Avatar } from '../bits'
import { BotBadge } from '../chat/BotBits'
import '../dialogs/InternetSettings.css'
import '../bots.css'

export function BuiltinBotsSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const listed = useBuiltinBots((s) => s.bots[server.key])
  const [busy, setBusy] = useState<BuiltinBotId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const admin = !!server.me && roleRank(server.me.role) >= roleRank('admin')
  if (!listed || listed.length === 0) return null // a server without built-in bots

  async function toggle(id: BuiltinBotId, enabled: boolean) {
    setBusy(id)
    setError(null)
    try {
      await setBuiltinBot(server.key, id, enabled)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-section builtin-bots">
      <h3>{t('builtinBots.settings.title')}</h3>
      <p className="muted">{t('builtinBots.settings.intro')}</p>
      {BUILTIN_BOTS.map((id) => {
        const bot = listed.find((b) => b.id === id)
        const on = !!bot?.enabled
        const name = t(`builtinBots.names.${id}`)
        return (
          <div key={id} className="bot-row builtin-bot-row">
            <Avatar name={name} accountKey={bot?.accountKey ?? id} size={32} />
            <span className="member-name">
              <span className="builtin-bot-name">{name} <BotBadge builtin /></span>
              <span className="builtin-bot-about muted">{t(`builtinBots.about.${id}`)}</span>
            </span>
            <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={t('builtinBots.settings.toggle', { name })}
              disabled={!admin || busy !== null} onClick={() => void toggle(id, !on)} data-testid={`builtin-${id}`}>
              <span />
            </button>
          </div>
        )
      })}
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  )
}
