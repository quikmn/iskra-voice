// Recording a call in the UI: the call button and its dialog, the strip above the call controls, the marks in the
// channel list and member list, and the notices (joined a recorded call, it started, an encrypted call asks).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CallRecording, VoiceParticipant } from '../../core/protocol'
import { useApp, type ServerState } from '../../state/store'
import { useVoice } from '../../state/voice'
import { has } from '../../state/permissions'
import { useServerBaseRoles } from '../../state/baseRoles'
import { useServerRoles } from '../../state/roles'
import {
  answerRecording, canRecordHere, clearRecordingError, dismissRecordingNotice, dismissSaved, loadRecordingFolder, pickRecordingFolder,
  setMixed, setOptOut, showRecordingFolder, startRecording, stopRecording, unmuteAfterNotice, useChannelRecording, useRecording,
  useRecordingBy,
} from '../../state/recording'
import { answers, isRecorded, needsAnswer, offsetLabel } from '../../state/recordingLogic'
import { Modal } from '../bits'
import { Close } from '../icons'
import './recording.css'

const RecordIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  </svg>
)

const StopIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </svg>
)

/** The voice channel you're in (not a DM or group call), with its server, mark and people. */
function useHere() {
  const session = useVoice((s) => s.session)
  const channelSession = session && !session.call && !session.group ? session : null
  const server = useApp((s) => (channelSession ? s.servers[channelSession.serverKey] : undefined))
  const mark = useChannelRecording(channelSession?.serverKey ?? '', channelSession?.channelId ?? 0)
  const participants = (channelSession && server?.voice[channelSession.channelId]) || []
  return { session: channelSession, server, mark, participants, me: server?.me?.accountKey ?? null }
}

const nameIn = (server: ServerState | undefined, key: string, fallback: string) => server?.members[key]?.name ?? fallback

/** "1:02:03" since a time, ticking every second. */
function useElapsed(since: number | null | undefined): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return since ? offsetLabel(now - since) : ''
}

/** The call button: start (opens the dialog) or stop. Only for people who may record, in voice channels. */
export function RecordButton() {
  const { t } = useTranslation()
  const { session, server, mark, me } = useHere()
  const roles = useServerRoles(session?.serverKey)
  const baseRoles = useServerBaseRoles(session?.serverKey ?? '')
  const busy = useRecording((s) => s.busy)
  const [open, setOpen] = useState(false)
  if (!session || !server) return null
  const mayRecord = has(server.me, roles, 'recordVoice', baseRoles)
  if (mark && mark.by === me) {
    return (
      <button className="call-button record-button on" onClick={() => void stopRecording()} disabled={busy} aria-label={t('recording.stop')} title={t('recording.stop')}>
        <StopIcon />
      </button>
    )
  }
  if (!mayRecord || mark) return null
  return (
    <>
      <button className="call-button record-button" onClick={() => setOpen(true)} aria-label={t('recording.record')} title={t('recording.record')}>
        <RecordIcon />
      </button>
      {open && <RecordDialog encrypted={!!server.channels.find((c) => c.id === session.channelId)?.e2ee} onClose={() => setOpen(false)} />}
    </>
  )
}

function RecordDialog({ encrypted, onClose }: { encrypted: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const folder = useRecording((s) => s.folder)
  const mixed = useRecording((s) => s.mixed)
  const busy = useRecording((s) => s.busy)
  const error = useRecording((s) => s.error)
  const desktopApp = canRecordHere()
  useEffect(() => {
    clearRecordingError()
    if (desktopApp) void loadRecordingFolder()
  }, [desktopApp])
  return (
    <Modal
      title={t('recording.dialog.title')}
      onClose={onClose}
      className="record-dialog"
      footer={desktopApp ? (
        <>
          <button className="button ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary record-start" disabled={busy} onClick={() => void startRecording().then((ok) => ok && onClose())}>
            <RecordIcon size={16} /> {t('recording.dialog.start')}
          </button>
        </>
      ) : <button className="button primary" onClick={onClose}>{t('common.close')}</button>}
    >
      {!desktopApp ? <p>{t('recording.dialog.desktopOnly')}</p> : (
        <>
          <p>{t('recording.dialog.about')}</p>
          <p>{t('recording.dialog.everyone')}</p>
          {encrypted && <p className="record-note">{t('recording.dialog.encrypted')}</p>}
          <div className="record-folder">
            <span className="muted">{t('recording.dialog.folder')}</span>
            <code title={folder ?? ''}>{folder ?? '…'}</code>
            <button className="button small" onClick={() => void pickRecordingFolder()}>{t('recording.dialog.change')}</button>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={mixed} onChange={(e) => setMixed(e.target.checked)} />
            {t('recording.dialog.mixed')}
          </label>
          <p className="muted record-note">{t('recording.dialog.limit')}</p>
          {error && <p className="error-text" role="alert">{typeof error === 'string' ? error : t(`recording.errors.${error.key}`)}</p>}
        </>
      )}
    </Modal>
  )
}

/** Above the call controls while the call is recorded (or being asked about): who, how long, and "Don't record me". */
export function RecordingStrip() {
  const { t } = useTranslation()
  const { server, mark, participants, me } = useHere()
  const optOut = useRecording((s) => s.optOut)
  const time = useElapsed(mark?.live ? (mark.liveAt ?? mark.startedAt) : null)
  if (!mark) return null
  const mine = mark.by === me
  const name = nameIn(server, mark.by, t('common.someone'))
  const self = participants.find((p) => p.accountKey === me)
  const inIt = !!self && isRecorded(self, mark)
  const { yes, total } = answers(participants)
  const text = !mark.live
    ? (mine ? t('recording.strip.youAsking', { yes, total }) : t('recording.strip.asking', { name, yes, total }))
    : mine ? t('recording.strip.you', { time }) : t('recording.strip.live', { name, time })
  return (
    <div className={`recording-strip ${mark.live ? 'live' : 'asking'}`} role="status" data-testid="recording-strip">
      <span className="recording-dot" aria-hidden />
      <span className="recording-text">{text}</span>
      {mark.live && !mine && !inIt && <span className="recording-left">{t('recording.strip.left')}</span>}
      {!mine && (
        <button className="link-like" onClick={() => setOptOut(!optOut)} aria-pressed={optOut}>
          {optOut ? t('recording.strip.recordMe') : t('recording.strip.dontRecord')}
        </button>
      )}
    </div>
  )
}

/** The red mark next to whoever is recording, and a crossed-out one next to people left out of it. */
export function RecordingMark({ participant, mark }: { participant: VoiceParticipant; mark: CallRecording | undefined }) {
  const { t } = useTranslation()
  if (!mark) return null
  if (mark.by === participant.accountKey) return <span className="recording-mark" role="img" aria-label={t('recording.mark')} title={t('recording.mark')}>{t('recording.channelMark')}</span>
  if (mark.live && !isRecorded(participant, mark)) {
    return <span className="recording-off" role="img" aria-label={t('recording.notRecorded')} title={t('recording.notRecorded')} />
  }
  return null
}

/** On a voice channel's row: "REC" while it's recorded. */
export function ChannelRecordingMark({ serverKey, channelId }: { serverKey: string; channelId: number }) {
  const { t } = useTranslation()
  const mark = useChannelRecording(serverKey, channelId)
  if (!mark) return null
  return <span className="recording-pill" role="img" aria-label={t('recording.channelMarkHint')} title={t('recording.channelMarkHint')}>{t('recording.channelMark')}</span>
}

/** In the member list: a small red dot on someone recording a call. */
export function MemberRecordingMark({ serverKey, accountKey }: { serverKey: string; accountKey: string }) {
  const { t } = useTranslation()
  if (!useRecordingBy(serverKey, accountKey)) return null
  return <span className="recording-dot member-rec" role="img" aria-label={t('recording.memberMark')} title={t('recording.memberMark')} />
}

/** In the voice bar under the channel list: "REC" while the call you're in is recorded. */
export function VoiceBarRecordingMark() {
  const { t } = useTranslation()
  const { server, mark } = useHere()
  if (!mark) return null
  return (
    <span className="recording-pill" role="img" aria-label={t('recording.markBy', { name: nameIn(server, mark.by, t('common.someone')) })} title={t('recording.markBy', { name: nameIn(server, mark.by, t('common.someone')) })}>
      {t('recording.channelMark')}
    </span>
  )
}

/** The notices, the encrypted question, errors and "saved", wherever you are in the app (phones too). */
export function RecordingLayer() {
  const { t } = useTranslation()
  const { session, server, mark, participants, me } = useHere()
  const notice = useRecording((s) => s.notice)
  const optOut = useRecording((s) => s.optOut)
  const error = useRecording((s) => s.error)
  const saved = useRecording((s) => s.saved)
  const muted = useVoice((s) => s.muted)
  const canSpeak = !!session?.canSpeak

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(clearRecordingError, 9000)
    return () => clearTimeout(timer)
  }, [error])
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(dismissSaved, 15000)
    return () => clearTimeout(timer)
  }, [saved])

  const ask = !!mark && needsAnswer(me, participants, mark)
  const name = mark ? nameIn(server, mark.by, t('common.someone')) : ''
  const showNotice = !ask && !!notice && !!mark && notice.serverKey === session?.serverKey && notice.channelId === session.channelId

  return (
    <div className="recording-layer" aria-live="polite">
      {ask && (
        <div className="recording-card" role="alertdialog" aria-label={t('recording.consent.title')} data-testid="recording-consent">
          <span className="recording-dot" aria-hidden />
          <div className="recording-card-body">
            <strong>{t('recording.consent.title')}</strong>
            <p>{mark!.live ? t('recording.consent.late', { name }) : t('recording.consent.ask', { name })}</p>
            <div className="recording-card-actions">
              <button className="button small" onClick={() => void answerRecording(false)}>{t('recording.consent.no')}</button>
              <button className="button small primary" onClick={() => void answerRecording(true)}>{t('recording.consent.yes')}</button>
            </div>
          </div>
        </div>
      )}
      {showNotice && (
        <div className="recording-card" role="alertdialog" aria-label={t('recording.mark')} data-testid="recording-notice">
          <span className="recording-dot" aria-hidden />
          <div className="recording-card-body">
            <p>
              {notice!.kind === 'started' ? t('recording.notice.started', { name })
                : notice!.mutedByUs && canSpeak ? t('recording.notice.joined', { name }) : t('recording.notice.joinedListening', { name })}
            </p>
            {optOut && <p className="muted">{t('recording.notice.leftOut')}</p>}
            <p className="muted small-print">{t('recording.notice.honest')}</p>
            <div className="recording-card-actions">
              {!optOut && <button className="button small" onClick={() => setOptOut(true)}>{t('recording.notice.dontRecord')}</button>}
              {notice!.mutedByUs && canSpeak && muted
                ? <button className="button small primary" onClick={() => void unmuteAfterNotice()}>{t('recording.notice.unmute')}</button>
                : <button className="button small primary" onClick={dismissRecordingNotice}>{t('recording.notice.ok')}</button>}
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="recording-toast error" role="alert">
          <span>{typeof error === 'string' ? error : t(`recording.errors.${error.key}`)}</span>
          <button className="icon-button small" onClick={clearRecordingError} aria-label={t('common.close')}><Close size={14} /></button>
        </div>
      )}
      {saved && (
        <div className="recording-toast" role="status">
          <span>{t('recording.saved')}</span>
          <button className="button small" onClick={showRecordingFolder}>{t('recording.open')}</button>
          <button className="icon-button small" onClick={dismissSaved} aria-label={t('common.close')}><Close size={14} /></button>
        </div>
      )}
    </div>
  )
}
