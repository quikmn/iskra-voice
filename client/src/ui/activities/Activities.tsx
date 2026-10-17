// Activities in a voice call: "Activities" in the call controls opens the launcher (built-ins and the server's own),
// others in the call see "X started Y — Join", and the activity takes the call's big spot while you're in it.
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActivitySession, Channel, ServerActivity } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import {
  endActivity, joinActivity, joinedFor, leaveActivity, loadCatalog, mayEnd, sessionFor, startActivity, startRefusal, useActivities,
} from '../../state/activities'
import { isBuiltin } from '../../state/activityHost'
import { errorMessage } from '../../i18n/errors'
import { t as i18t } from '../../i18n'
import { Avatar, Modal } from '../bits'
import { pageWall } from '../profile/PageView'
import { ActivityIcon, BuiltinIcon } from './icons'
import { ActivityFrame } from './ActivityFrame'
import './activities.css'

/** A session's or catalog entry's name: built-ins in your language. */
function activityName(activity: string, name: string | null | undefined): string {
  return isBuiltin(activity) ? i18t(`activities.builtins.${activity}.name`) : (name ?? i18t('activities.title'))
}

/** Server-added activities run only behind the desktop app's wall (PROTOCOL.md → Activities). */
const canRun = (activity: string) => isBuiltin(activity) || pageWall()

const nameIn = (server: ServerState, accountKey: string) => server.members[accountKey]?.name ?? i18t('common.someone')

/** Whether the server sees us in the call yet (it hears it from LiveKit; until then it refuses activities). */
const inCall = (server: ServerState, channelId: number) => (server.voice[channelId] ?? []).some((p) => p.accountKey === server.me?.accountKey)

/** "Activities" in the call controls. */
export function ActivityButton({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const session = useActivities(sessionFor(server.key, channel.id))
  const joined = useActivities(joinedFor(server.key, channel.id))
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (channel.kind !== 'voice' || server.me?.bot) return null

  // Encrypted voice channels: off, and a tap says why (phones have no hover titles).
  if (channel.e2ee) return (
    <>
      <button className="call-button act-off" aria-label={t('activities.button')} title={t('activities.e2eeOff')} onClick={() => setOpen(true)} data-testid="activity-e2ee-off">
        <ActivityIcon />
      </button>
      {open && <Modal title={t('activities.title')} onClose={() => setOpen(false)}><p data-testid="activity-e2ee-note">{t('activities.e2eeOff')}</p></Modal>}
    </>
  )

  async function click() {
    setError(null)
    if (joined && session) return void leaveActivity(server.key, channel.id, session.id)
    if (session) {
      if (!canRun(session.activity)) return setOpen(true)
      try {
        await joinActivity(server.key, channel.id, session.id)
      } catch (e) {
        setError(errorMessage(e))
      }
      return
    }
    setOpen(true)
  }

  const label = joined ? t('activities.leave') : session ? t('activities.join') : t('activities.start')
  return (
    <>
      <button className={`call-button ${joined ? 'on' : ''} ${session && !joined ? 'act-waiting' : ''}`} onClick={() => void click()} aria-pressed={!!joined}
        disabled={!joined && !inCall(server, channel.id)}
        aria-label={label} title={error ?? label} data-testid="activity-button">
        <ActivityIcon />
      </button>
      {error && <span className="sr-only" role="alert">{error}</span>}
      {open && !session && <ActivityLauncher server={server} channel={channel} onClose={() => setOpen(false)} />}
      {open && session && (
        <Modal title={t('activities.title')} onClose={() => setOpen(false)}><p>{t('activities.desktopOnlyHint')}</p></Modal>
      )}
    </>
  )
}

/** The list to start from: built-ins first, then the server's own. */
export function ActivityLauncher({ server, channel, onClose }: { server: ServerState; channel: Channel; onClose: () => void }) {
  const { t } = useTranslation()
  const catalog = useActivities((s) => s.catalogs[server.key])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!catalog) loadCatalog(server.key).catch((e) => setError(errorMessage(e)))
  }, [server.key, catalog])

  const refusal = startRefusal(server, channel, catalog)
  const waiting = !inCall(server, channel.id)
  const note = refusal === 'off' ? t('activities.offHere') : refusal === 'role' ? t('activities.roleTooLow') : refusal === 'listen' ? t('activities.listenOnly') : null

  async function start(id: string) {
    setBusy(id)
    setError(null)
    try {
      await startActivity(server.key, channel.id, id)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  const builtins = catalog?.builtins.filter((b) => b.enabled) ?? []
  const added = catalog?.activities.filter((a) => a.enabled) ?? []
  const players = (min: number, max: number) =>
    min === max ? t('activities.playersExact', { n: min }) : max >= 25 ? t('activities.playersFrom', { min }) : t('activities.players', { min, max })
  return (
    <Modal title={t('activities.start')} onClose={onClose} wide>
      <p className="muted">{t('activities.intro')}</p>
      {note && <p className="activity-note" role="note">{note}</p>}
      {!catalog && !error && <p className="muted">{t('activities.loading')}</p>}
      {catalog && builtins.length + added.length === 0 && <p className="muted">{t('activities.noneAvailable')}</p>}
      {builtins.length > 0 && (
        <>
          <h3 className="activity-group">{t('activities.builtIn')}</h3>
          <ul className="activity-list">
            {builtins.map(({ id }) => (
              <ActivityChoice key={id} name={t(`activities.builtins.${id}.name`)} description={t(`activities.builtins.${id}.description`)}
                icon={<BuiltinIcon id={id} />} players={id === 'four' ? players(2, 2) : players(2, 25)}
                disabled={!!refusal || !!busy || waiting} busy={busy === id} onStart={() => void start(id)} />
            ))}
          </ul>
        </>
      )}
      {added.length > 0 && (
        <>
          <h3 className="activity-group">{t('activities.fromServer')}</h3>
          {!pageWall() && <p className="muted small-print" data-testid="activity-desktop-only">{t('activities.desktopOnlyHint')}</p>}
          <ul className="activity-list">
            {added.map((a) => (
              <ActivityChoice key={a.id} name={a.name} description={a.description} icon={<ServerActivityIcon server={server} activity={a} />}
                players={players(a.minPlayers, a.maxPlayers)} disabled={!!refusal || !!busy || waiting || !pageWall()} busy={busy === a.id}
                blocked={!pageWall()} onStart={() => void start(a.id)} />
            ))}
          </ul>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}

function ServerActivityIcon({ server, activity }: { server: ServerState; activity: ServerActivity }) {
  const [broken, setBroken] = useState(false)
  if (!activity.icon || broken) return <ActivityIcon size={28} />
  return <img src={server.url + activity.icon} alt="" width={28} height={28} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
}

function ActivityChoice({ name, description, icon, players, disabled, busy, blocked, onStart }: {
  name: string; description: string; icon: ReactNode; players: string; disabled: boolean; busy: boolean; blocked?: boolean; onStart: () => void
}) {
  const { t } = useTranslation()
  return (
    <li className="activity-choice" data-testid="activity-choice">
      <span className="activity-choice-icon">{icon}</span>
      <span className="activity-choice-text">
        <strong>{name}</strong>
        {description && <span className="muted">{description}</span>}
        <span className="muted small-text">{players}{blocked ? ` · ${t('activities.desktopOnly')}` : ''}</span>
      </span>
      <button className="button primary" disabled={disabled} onClick={onStart} aria-label={t('activities.startNamed', { name })}>
        {busy ? '…' : t('activities.startIt')}
      </button>
    </li>
  )
}

/** In the call's big spot: the activity while you're in it, else who started what and a Join button. */
export function ActivityPanel({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const session = useActivities(sessionFor(server.key, channel.id))
  const joined = useActivities(joinedFor(server.key, channel.id))
  const [error, setError] = useState<string | null>(null)
  if (!session) return null
  const name = activityName(session.activity, session.name)
  const callers = (server.voice[channel.id] ?? []).map((p) => p.accountKey)

  if (!joined || joined.session.id !== session.id) {
    const runnable = canRun(session.activity)
    async function join() {
      setError(null)
      try {
        await joinActivity(server.key, channel.id, session!.id)
      } catch (e) {
        setError(errorMessage(e))
      }
    }
    return (
      <div className="activity-invite" data-testid="activity-invite" role="group" aria-label={name}>
        <span className="activity-choice-icon">{isBuiltin(session.activity) ? <BuiltinIcon id={session.activity} /> : <ActivityIcon size={28} />}</span>
        <span className="activity-invite-text">
          <strong>{t('activities.startedBy', { person: nameIn(server, session.startedBy), name })}</strong>
          <Players server={server} session={session} />
          {!runnable && <span className="muted small-text">{t('activities.desktopOnlyHint')}</span>}
          {error && <span className="error-text" role="alert">{error}</span>}
        </span>
        <button className="button primary" disabled={!runnable || !inCall(server, channel.id)} onClick={() => void join()}>{t('activities.join')}</button>
      </div>
    )
  }

  return (
    <section className="activity-call" aria-label={name} data-testid="activity-panel">
      <header className="activity-head">
        {isBuiltin(session.activity) ? <BuiltinIcon id={session.activity} size={16} /> : <ActivityIcon size={16} />}
        <strong>{name}</strong>
        <Players server={server} session={session} />
        <span className="activity-spacer" />
        {mayEnd(server, session, callers) && (
          <button className="button small" onClick={() => void endActivity(server.key, channel.id, session.id).catch((e) => setError(errorMessage(e)))}>{t('activities.end')}</button>
        )}
        <button className="button small" onClick={() => void leaveActivity(server.key, channel.id, session.id)}>{t('activities.leave')}</button>
      </header>
      {joined.missed && <p className="activity-note">{t('activities.missed')}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <ActivityFrame key={session.id} server={server} channel={channel} session={session} joined={joined} name={name} />
    </section>
  )
}

function Players({ server, session }: { server: ServerState; session: ActivitySession }) {
  const { t } = useTranslation()
  const names = session.players.map((p) => nameIn(server, p.accountKey))
  return (
    <span className="activity-players" title={t('activities.playing', { names: names.join(', ') })} aria-label={t('activities.playing', { names: names.join(', ') })}>
      {session.players.slice(0, 6).map((p) => <Avatar key={p.accountKey} name={nameIn(server, p.accountKey)} accountKey={p.accountKey} size={20} />)}
    </span>
  )
}

/** In the call's text chat: what's on (with Join), or a way to start one. */
export function ActivityChatStrip({ server, channelId }: { server: ServerState; channelId: number }) {
  const { t } = useTranslation()
  const channel = server.channels.find((c) => c.id === channelId)
  const session = useActivities(sessionFor(server.key, channelId))
  const joined = useActivities(joinedFor(server.key, channelId))
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!channel || channel.kind !== 'voice' || channel.e2ee || server.me?.bot || (session && joined)) return null
  async function join() {
    setError(null)
    try {
      await joinActivity(server.key, channelId, session!.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className="activity-strip" data-testid="activity-chat-strip">
      <ActivityIcon size={16} />
      {session ? (
        <>
          <span className="activity-strip-text">{t('activities.startedBy', { person: nameIn(server, session.startedBy), name: activityName(session.activity, session.name) })}</span>
          <button className="button small primary" disabled={!canRun(session.activity) || !inCall(server, channelId)} onClick={() => void join()}>{t('activities.join')}</button>
        </>
      ) : (
        <button className="button small" onClick={() => setOpen(true)}>{t('activities.start')}</button>
      )}
      {error && <span className="error-text" role="alert">{error}</span>}
      {open && <ActivityLauncher server={server} channel={channel} onClose={() => setOpen(false)} />}
    </div>
  )
}
