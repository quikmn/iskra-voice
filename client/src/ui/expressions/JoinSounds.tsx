// Join sounds: your pick on each server and whether you hear other people's (My settings → Voice & audio), and the
// owner's switch for a server (Server settings → Soundboard).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { roleRank } from '../../core/protocol'
import { playUrl, serverFileUrl, useServerSounds } from '../../state/expressions'
import { setHearJoinSounds, setJoinSound, setJoinSoundsEnabled, useJoinSounds } from '../../state/joinSounds'
import { fitsJoinSound, JOIN_SOUND_MAX_MS } from '../../state/joinSoundLogic'
import { useApp, type ServerState } from '../../state/store'
import { errorMessage } from '../../i18n/errors'
import { SwitchRow } from '../kit'
import { ServerTile } from '../settings/ServerTile'
import { Play } from './icons'

export function JoinSoundSettingsSection() {
  const { t } = useTranslation()
  const hear = useJoinSounds((s) => s.hear)
  const supported = useJoinSounds((s) => s.supported)
  const order = useApp((s) => s.order)
  const servers = useApp((s) => s.servers)
  const mine = order.map((key) => servers[key]).filter((server): server is ServerState => !!server?.me && !!supported[server.key])
  return (
    <section className="settings-section" data-testid="join-sounds-section">
      <h2>{t('expressions.joinSounds.title')}</h2>
      <p className="muted">{t('expressions.joinSounds.intro', { seconds: JOIN_SOUND_MAX_MS / 1000 })}</p>
      {mine.length === 0 ? <p className="muted">{t('expressions.joinSounds.noServers')}</p> : (
        <ul className="join-sound-list">
          {mine.map((server) => <JoinSoundRow key={server.key} server={server} />)}
        </ul>
      )}
      <SwitchRow title={t('expressions.joinSounds.hear')} help={t('expressions.joinSounds.hearHint')} checked={hear} onChange={setHearJoinSounds} />
    </section>
  )
}

function JoinSoundRow({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const choice = useJoinSounds((s) => s.mine[server.key])
  const sounds = useServerSounds(server.key)
  const [error, setError] = useState<string | null>(null)
  const short = sounds.filter((sound) => fitsJoinSound(sound, choice?.maxMs))
  const picked = short.find((sound) => sound.id === choice?.soundId)
  const url = picked ? serverFileUrl(server.key, picked.url) : null
  const off = choice?.enabled === false
  return (
    <li className="join-sound-row">
      <ServerTile server={server} size="small" />
      <div className="join-sound-fields">
        <span className="join-sound-server">{server.name}</span>
        {off ? <span className="muted">{t('expressions.joinSounds.off')}</span>
          : short.length === 0 ? <span className="muted">{t('expressions.joinSounds.empty')}</span>
          : (
            <select
              value={picked?.id ?? ''} disabled={!choice} aria-label={t('expressions.joinSounds.pick', { server: server.name })}
              onChange={(e) => void setJoinSound(server.key, e.target.value || null).then(() => setError(null), (err: Error) => setError(errorMessage(err)))}
            >
              <option value="">{t('expressions.joinSounds.none')}</option>
              {short.map((sound) => <option key={sound.id} value={sound.id}>{sound.emoji ? `${sound.emoji} ` : ''}{sound.name}</option>)}
            </select>
          )}
        {error && <span className="error-text">{error}</span>}
      </div>
      {!off && picked && (
        <button className="icon-button" aria-label={t('expressions.settings.preview', { name: picked.name })} title={t('expressions.settings.previewTitle')} disabled={!url} onClick={() => url && playUrl(url, undefined, choice?.maxMs)}>
          <Play size={16} />
        </button>
      )}
    </li>
  )
}

/** The owner: whether this server plays join sounds at all. Others see nothing. */
export function ServerJoinSoundsOption({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const choice = useJoinSounds((s) => s.mine[server.key])
  const [error, setError] = useState<string | null>(null)
  if (!server.me || roleRank(server.me.role) < roleRank('owner') || !choice) return null
  return (
    <section className="settings-section" data-testid="server-join-sounds">
      <SwitchRow
        title={t('expressions.joinSounds.serverSwitch')} help={t('expressions.joinSounds.serverSwitchHint')} checked={choice.enabled}
        onChange={(on) => void setJoinSoundsEnabled(server.key, on).then(() => setError(null), (err: Error) => setError(errorMessage(err)))}
      />
      {error && <p className="error-text">{error}</p>}
    </section>
  )
}
