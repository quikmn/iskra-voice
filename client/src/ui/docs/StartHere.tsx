// The server's "Start here" page, pinned above the channel list.
import './docs.css'
import { useTranslation } from 'react-i18next'
import { activeChannelId, useApp, type ServerState } from '../../state/store'
import { docsKey, goToPage, useDocs } from '../../state/docs'
import { setStageOpen } from '../../state/voice'
import { FlagIcon } from './icons'

export function StartHereEntry({ server, onNavigate }: { server: ServerState; onNavigate: () => void }) {
  const { t } = useTranslation()
  const home = useDocs((s) => s.home[server.key])
  const activeId = useApp(activeChannelId)
  const openId = useDocs((s) => (home ? s.open[docsKey(server.key, home.channelId)] : undefined))
  if (!home || !server.channels.some((c) => c.id === home.channelId)) return null
  const active = activeId === home.channelId && openId === home.pageId
  return (
    <div className="org-row start-here-row">
      <button
        className={`channel start-here ${active ? 'active' : ''}`}
        title={t('docs.home.title')}
        onClick={() => {
          setStageOpen(false)
          goToPage(server.key, home.channelId, home.pageId)
          onNavigate()
        }}
      >
        <span className="hash"><FlagIcon size={16} /></span>
        <span className="channel-name">{home.title}</span>
      </button>
    </div>
  )
}
