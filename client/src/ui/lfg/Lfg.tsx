// Looking for group: the post inside a message (slots, Join/Leave, Join voice), the dialog that creates one, and the
// toasts for joins, a full group and new posts.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from '../../core/protocol'
import { formatDate, formatList } from '../../i18n/format'
import { errorMessage } from '../../i18n/errors'
import { closeLfg, closeLfgPost, createLfg, dismissLfgNotice, joinLfg, leaveLfg, openPost, setLfgNotify, useLfg } from '../../state/lfg'
import { defaultStart, fromLocalInput, LFG_LIMITS, lfgStatus, slotsLeft, toLocalInput, validStart } from '../../state/lfgLogic'
import { useServerRoles } from '../../state/roles'
import { outranks, has } from '../../state/permissions'
import type { ServerState } from '../../state/store'
import { useApp } from '../../state/store'
import { joinVoice, useVoice } from '../../state/voice'
import { Avatar, Modal } from '../bits'
import { Close } from '../icons'
import '../update-toast.css'
import './lfg.css'

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const when = (ms: number) => formatDate(ms, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

export function LfgCard({ server, message }: { server: ServerState; message: Message }) {
  const { t } = useTranslation()
  const lfg = message.lfg!
  const roles = useServerRoles(server.key)
  const me = server.me
  const now = useNow(lfg.closedAt === null)
  const status = lfgStatus(lfg, now)
  const mine = message.author === me?.accountKey
  const joined = !!me && lfg.joined.includes(me.accountKey)
  const inVoice = useVoice((s) => s.session?.serverKey === server.key && s.session.channelId === lfg.voiceChannelId)
  const voice = lfg.voiceChannelId !== null ? server.channels.find((c) => c.id === lfg.voiceChannelId) : undefined
  const author = server.members[message.author]
  const canClose = !!me && status !== 'closed' && (mine || (has(me, roles, 'manageMessages') && (!author || outranks(me, author, roles))))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const names = lfg.joined.map((k) => server.members[k]?.name ?? t('common.someone'))
  const left = slotsLeft(lfg)
  const statusText = status === 'closed' ? t('lfg.card.closed') : status === 'full' ? t('lfg.card.full') : t('lfg.card.left', { count: left })

  return (
    <div className={`lfg-card ${status}`} role="group" aria-label={t('lfg.card.label', { game: lfg.game })} data-testid="lfg-card">
      <div className="lfg-head">
        <span className="lfg-tag">{t('lfg.card.tag')}</span>
        <span className="lfg-game">{lfg.game}</span>
      </div>
      <div className="lfg-meta">
        <span>{t('lfg.card.lookingFor', { count: lfg.slots })}</span>
        {lfg.startAt !== null && <span>· {when(lfg.startAt)}</span>}
        {voice && <span>· {t('lfg.card.voice', { channel: voice.name })}</span>}
      </div>
      {lfg.note && <div className="lfg-note">{lfg.note}</div>}
      <ul className="lfg-slots" aria-label={t('lfg.card.slots', { joined: lfg.joined.length, slots: lfg.slots })}>
        {lfg.joined.map((k, i) => (
          <li key={k} className="lfg-slot taken" title={names[i]}><Avatar name={names[i]} accountKey={k} size={28} /></li>
        ))}
        {Array.from({ length: left }, (_, i) => <li key={`free-${i}`} className="lfg-slot free" aria-hidden />)}
      </ul>
      {names.length > 0 && <div className="lfg-names muted">{t('lfg.card.joined', { names: formatList(names) })}</div>}
      <div className="lfg-footer">
        <span className={`lfg-status ${status}`}>{statusText}</span>
        <span className="spacer" />
        {status === 'open' && !mine && !joined && (
          <button className="button primary small" disabled={busy} onClick={() => void run(() => joinLfg(server.key, message.id))}>{t('lfg.card.join')}</button>
        )}
        {status !== 'closed' && joined && (
          <button className="link" disabled={busy} onClick={() => void run(() => leaveLfg(server.key, message.id))}>{t('lfg.card.leave')}</button>
        )}
        {voice && (mine || joined) && status !== 'closed' && !inVoice && (
          <button className={`button small ${status === 'full' ? 'primary' : ''}`} disabled={!server.voiceAvailable} onClick={() => void joinVoice(server.key, voice.id)}>
            {t('lfg.joinVoice')}
          </button>
        )}
        {canClose && <button className="link danger-link" disabled={busy} onClick={() => void run(() => closeLfgPost(server.key, message.id))}>{t('lfg.card.close')}</button>}
      </div>
      {error && <div className="message-failed" role="alert">{error}</div>}
    </div>
  )
}

/** Mounted once (Shell): the create dialog, for whichever channel asked. */
export function LfgLayer() {
  const composing = useLfg((s) => s.composing)
  const server = useApp((s) => (composing ? s.servers[composing.serverKey] : undefined))
  if (!composing || !server) return null
  return <LfgDialog key={`${composing.serverKey}:${composing.channelId}`} server={server} channelId={composing.channelId} game={composing.game} slots={composing.slots} />
}

function LfgDialog({ server, channelId, game: initialGame, slots: initialSlots }: { server: ServerState; channelId: number; game: string; slots: number | null }) {
  const { t } = useTranslation()
  const [game, setGame] = useState(initialGame)
  const [slots, setSlots] = useState(initialSlots ?? 3)
  const [timed, setTimed] = useState(false)
  const [start, setStart] = useState(() => toLocalInput(defaultStart(Date.now())))
  const voiceChannels = server.channels.filter((c) => c.kind === 'voice' || c.kind === 'stage')
  const [voiceId, setVoiceId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const notify = useLfg((s) => s.notify[server.key])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const channel = server.channels.find((c) => c.id === channelId)
  const startAt = timed ? fromLocalInput(start) : null
  const problem = !game.trim() ? t('lfg.dialog.needGame')
    : timed && (startAt === null || !validStart(startAt, Date.now())) ? t('lfg.dialog.badTime') : null

  async function post() {
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await createLfg(server.key, {
        channelId, game: game.trim(), slots,
        ...(startAt !== null ? { startAt } : {}),
        ...(voiceId !== null ? { voiceChannelId: voiceId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      closeLfg()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('lfg.dialog.title')}
      heading={channel ? t('lfg.dialog.heading', { channel: channel.name }) : t('lfg.dialog.title')}
      onClose={closeLfg}
      className="lfg-dialog"
      footer={
        <>
          {error && <span className="error-text" role="alert">{error}</span>}
          <button className="button" onClick={closeLfg}>{t('common.cancel')}</button>
          <button className="button primary" data-testid="lfg-post" disabled={busy || !!problem} onClick={() => void post()}>{t('lfg.dialog.post')}</button>
        </>
      }
    >
      <label className="field">
        <span>{t('lfg.dialog.game')}</span>
        <input value={game} maxLength={LFG_LIMITS.game} placeholder={t('lfg.dialog.gamePlaceholder')} autoFocus onChange={(e) => setGame(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('lfg.dialog.slots')}</span>
        <select value={slots} onChange={(e) => setSlots(Number(e.target.value))}>
          {Array.from({ length: LFG_LIMITS.maxSlots }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{t('lfg.dialog.people', { count: n })}</option>)}
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} />
        {t('lfg.dialog.timed')}
      </label>
      {timed && (
        <label className="field">
          <span>{t('lfg.dialog.when')}</span>
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>{t('lfg.dialog.voice')}</span>
        <select value={voiceId ?? ''} onChange={(e) => setVoiceId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t('lfg.dialog.noVoice')}</option>
          {voiceChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>{t('lfg.dialog.note')}</span>
        <input value={note} maxLength={LFG_LIMITS.note} placeholder={t('lfg.dialog.notePlaceholder')} onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="muted lfg-expiry">{timed ? t('lfg.dialog.expiresTimed') : t('lfg.dialog.expiresDay')}</p>
      {notify !== undefined && (
        <label className="checkbox">
          <input type="checkbox" checked={notify} onChange={(e) => void setLfgNotify(server.key, e.target.checked).catch(() => undefined)} />
          {t('lfg.notifyMeLong')}
        </label>
      )}
    </Modal>
  )
}

/** "Bob joined your group", "Your group is full" (with Join voice), "Alice is looking for 3 for Valheim". */
export function LfgToast() {
  const { t } = useTranslation()
  const notice = useLfg((s) => s.notices[s.notices.length - 1])
  const server = useApp((s) => (notice ? s.servers[notice.serverKey] : undefined))
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => dismissLfgNotice(notice.at), notice.kind === 'full' ? 60_000 : 12_000)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice || !server) return null
  const who = notice.accountKey ? server.members[notice.accountKey]?.name ?? t('common.someone') : ''
  const voice = notice.voiceChannelId !== null ? server.channels.find((c) => c.id === notice.voiceChannelId) : undefined
  const title = notice.kind === 'joined' ? t('lfg.notify.joinedTitle', { name: who, game: notice.game })
    : notice.kind === 'full' ? t('lfg.notify.fullTitle', { game: notice.game })
    : t('lfg.notify.postedTitle', { name: who, game: notice.game })
  return (
    <div className="update-toast lfg-toast" role="status" aria-live="polite" data-testid="lfg-toast">
      <div className="update-toast-text">
        <strong>{title}</strong>
        <span>{notice.kind === 'full' ? t('lfg.notify.fullBody') : notice.kind === 'posted' ? t('lfg.notify.postedBody') : server.name}</span>
      </div>
      {notice.kind === 'full' && voice && (
        <button className="button primary small" disabled={!server.voiceAvailable} onClick={() => { void joinVoice(server.key, voice.id); dismissLfgNotice(notice.at) }}>
          {t('lfg.joinVoice')}
        </button>
      )}
      {notice.kind !== 'full' && (
        <button className="button small" onClick={() => { openPost(notice.serverKey, notice.channelId, notice.id)(); dismissLfgNotice(notice.at) }}>{t('lfg.notify.open')}</button>
      )}
      <button className="icon-button" onClick={() => dismissLfgNotice(notice.at)} aria-label={t('app.dismiss')} title={t('app.dismiss')}>
        <Close size={16} />
      </button>
    </div>
  )
}
