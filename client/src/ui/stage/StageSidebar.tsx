import { roleRank } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { listenerLabel, stageFor, stageView, useStages } from '../../state/stages'
import { joinVoice, useVoice } from '../../state/voice'
import { Avatar } from '../bits'
import { Plus } from '../icons'
import { StageIcon } from './stageIcons'
import './stage.css'

/** The "Stages" group in the channel list: live badge, topic, who's speaking and how many listen. */
export function StageSidebar({ server, onNavigate, onCreate }: { server: ServerState; onNavigate: () => void; onCreate: () => void }) {
  const stages = server.channels.filter((c) => c.kind === 'stage')
  const isAdmin = server.me ? roleRank(server.me.role) >= roleRank('admin') : false
  if (stages.length === 0) return null
  return (
    <>
      <div className="channel-group">
        <span>Stages</span>
        {isAdmin && (
          <button className="icon-button small" onClick={onCreate} aria-label="Create stage" title="Create channel">
            <Plus size={14} />
          </button>
        )}
      </div>
      {stages.map((channel) => <StageEntry key={channel.id} server={server} channelId={channel.id} name={channel.name} onNavigate={onNavigate} />)}
    </>
  )
}

function StageEntry({ server, channelId, name, onNavigate }: { server: ServerState; channelId: number; name: string; onNavigate: () => void }) {
  const state = useStages(stageFor(server.key, channelId))
  const session = useVoice((s) => s.session)
  const here = session?.serverKey === server.key && session.channelId === channelId && !session.call
  const { speakers, audience } = stageView(state, server.voice[channelId] ?? [])
  const live = !!state?.live
  return (
    <div className={`voice-channel stage-entry ${live ? 'live' : ''}`}>
      <button
        className={`channel ${here ? 'active' : ''}`}
        disabled={!server.voiceAvailable}
        title={server.voiceAvailable ? `Join ${name}` : 'Voice is unavailable on this server'}
        onClick={() => {
          void joinVoice(server.key, channelId)
          onNavigate()
        }}
      >
        <span className="hash"><StageIcon size={16} /></span>
        <span className="channel-name">{name}</span>
        {here && session.state !== 'connected' && <span className="pill">…</span>}
        {live && <span className="live-pill">Live</span>}
      </button>
      {live && (
        <div className="stage-entry-info">
          <span className="stage-entry-topic" title={state?.topic ?? undefined}>{state?.topic}</span>
          <span className="stage-entry-meta">
            <span className="stage-entry-speakers" aria-hidden>
              {speakers.slice(0, 4).map((p) => <Avatar key={p.accountKey} name={server.members[p.accountKey]?.name ?? '?'} accountKey={p.accountKey} size={18} />)}
            </span>
            {listenerLabel(audience.length)}
          </span>
        </div>
      )}
    </div>
  )
}
