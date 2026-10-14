// "<Server> is restarting, hold on…" while the server restarts (close 1012), then "<Server> is back." for a moment.
import { useTranslation } from 'react-i18next'
import { useResume } from '../state/resume'
import type { ServerState } from '../state/store'
import { useVoice, voiceResume } from '../state/voice'
import { useAnnounce } from './a11y'
import './restart.css'

export function RestartBanner({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const back = useResume((s) => !!s.back[server.key])
  const inVoiceHere = useVoice((s) => !!s.session && !s.session.call && !s.session.group && s.session.serverKey === server.key)
  const restarting = server.status.state === 'restarting'
  const voice = restarting && (inVoiceHere || voiceResume()?.serverKey === server.key)
  const update = server.status.state === 'restarting' && !!server.status.update
  const key = update ? (voice ? 'chat.view.restartingUpdateVoice' : 'chat.view.restartingUpdate') : voice ? 'chat.view.restartingVoice' : 'chat.view.restarting'
  // Mounted with its text, a status region isn't always read: say it too.
  useAnnounce(restarting ? t(key, { name: server.name })
    : back && server.status.state === 'online' ? t('chat.view.back', { name: server.name }) : null)
  if (restarting) {
    return (
      <div className="banner restart-banner" role="status" aria-live="polite">
        <span className="restart-spinner" aria-hidden="true" />
        <span>{t(key, { name: server.name })}</span>
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
