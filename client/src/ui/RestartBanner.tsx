// "<Server> is restarting, hold on…" while the server restarts (close 1012), then "<Server> is back." for a moment.
import { useTranslation } from 'react-i18next'
import { useResume } from '../state/resume'
import type { ServerState } from '../state/store'
import { useVoice, voiceResume } from '../state/voice'
import './restart.css'

export function RestartBanner({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const back = useResume((s) => !!s.back[server.key])
  const inVoiceHere = useVoice((s) => !!s.session && !s.session.call && !s.session.group && s.session.serverKey === server.key)
  if (server.status.state === 'restarting') {
    const voice = inVoiceHere || voiceResume()?.serverKey === server.key
    return (
      <div className="banner restart-banner" role="status" aria-live="polite">
        <span className="restart-spinner" aria-hidden="true" />
        <span>{t(voice ? 'chat.view.restartingVoice' : 'chat.view.restarting', { name: server.name })}</span>
      </div>
    )
  }
  if (back && server.status.state === 'online') {
    return (
      <div className="banner restart-banner back" role="status" aria-live="polite">
        <span className="restart-dot" aria-hidden="true" />
        <span>{t('chat.view.back', { name: server.name })}</span>
      </div>
    )
  }
  return null
}
