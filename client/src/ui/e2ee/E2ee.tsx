// End-to-end encrypted channels in the UI: the lock badge, the encryption panel (members, safety numbers, new key),
// decrypted attachments and notices on messages, and the "waiting for the key" line in the composer.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, Message } from '../../core/protocol'
import { t } from '../../i18n'
import { en } from '../../i18n/en'
import { errorMessage } from '../../i18n/errors'
import { BEFORE_YOU_JOINED, encryptedChannel, rekeyChannel, shownOf, slotOf, startOver, useE2ee, type ChannelCrypto } from '../../state/e2eeChannels'
import { checkStartOver } from '../../state/e2eeStartOver'
import { findingsAbout, useKt, type Finding } from '../../state/kt'
import { resolveKey, sameAccount } from '../../state/keyMap'
import { useDms } from '../../state/dms'
import { formatDate } from '../../i18n/format'
import type { ServerState } from '../../state/store'
import { MAX_CHANNEL_MEMBERS } from '../../core/channelChain'
import { DmAttachments } from '../dms/DmFiles'
import { dmErrorText } from '../../state/dms'
import { SafetyNumberDialog } from '../Home'
import { Modal } from '../bits'
import { Lock } from '../icons'
import './e2ee.css'

/** Core and state errors are written in English; this shows the known ones in the reader's language. */
export function e2eeText(text: string): string {
  if (text === 'waiting') return t('e2ee.waiting')
  for (const [id, english] of Object.entries(en.e2ee.errors)) if (english === text) return t(`e2ee.errors.${id as keyof typeof en.e2ee.errors}`)
  // The ones encrypted channels share with DMs (tampered, unverified sender, ...).
  return dmErrorText({ message: text })
}

export function LockBadge({ channel, size = 12 }: { channel: Pick<Channel, 'e2ee'>; size?: number }) {
  if (!channel.e2ee) return null
  return (
    <span className="e2ee-lock" title={t('e2ee.badge')} aria-label={t('e2ee.badge')} role="img" data-testid="e2ee-lock">
      <Lock size={size} />
    </span>
  )
}

/** Header button of an encrypted channel: opens the encryption panel. */
export function EncryptionButton({ server, channel }: { server: ServerState; channel: Channel | undefined }) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const state = useE2ee((s) => (channel ? s.channels[slotOf(server.key, channel.id)] : undefined))
  if (!channel?.e2ee) return null
  const warn = !!state?.problem
  return (
    <>
      <button className={`icon-button e2ee-header ${warn ? 'warn' : ''}`} onClick={() => setOpen(true)} aria-label={t('e2ee.panel.open')} title={t('e2ee.badge')}
        data-testid="e2ee-panel-open">
        <Lock size={18} />
      </button>
      {open && <EncryptionDialog server={server} channel={channel} onClose={() => setOpen(false)} />}
    </>
  )
}

function EncryptionDialog({ server, channel, onClose }: { server: ServerState; channel: Channel; onClose: () => void }) {
  const { t } = useTranslation()
  const state = useE2ee((s) => s.channels[slotOf(server.key, channel.id)])
  const findings = useKt((s) => s.findings)
  const [verify, setVerify] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const myKey = server.me?.accountKey ?? ''
  const members = state?.members ?? []

  async function rekey() {
    setBusy(true)
    setNote(null)
    try {
      await rekeyChannel(server.key, channel.id)
      setNote(t('e2ee.panel.rekeyDone'))
    } catch (e) {
      setNote(e2eeText(errorMessage(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('e2ee.panel.title')} onClose={onClose} className="e2ee-dialog">
      {state?.offer ? <StartOverSection server={server} channel={channel} state={state} findings={findings} onVerify={setVerify} />
        : state?.problem && <p className="error-text" role="alert">{t('e2ee.panel.problem', { problem: e2eeText(state.problem) })}</p>}
      <p>{t('e2ee.panel.intro')}</p>
      <ul className="e2ee-members" data-testid="e2ee-members">
        {members.map((key) => {
          const warn = findingsAbout(findings, key).length > 0
          return (
            <li key={key}>
              <span className="e2ee-member-name">{server.members[key]?.name ?? key.slice(0, 8)}{key === myKey && <span className="muted"> ({t('e2ee.panel.you')})</span>}</span>
              {warn && <span className="e2ee-warn" title={t('e2ee.panel.warning')}>⚠</span>}
              {key !== myKey && <button className="link" onClick={() => setVerify(key)}>{t('e2ee.panel.safetyNumber')}</button>}
            </li>
          )
        })}
      </ul>
      {state && <p className="muted small-text">{t('e2ee.panel.version', { version: state.version })}</p>}
      {state?.full && <p className="muted">{t('e2ee.panel.full')}</p>}
      {state && !state.hasKey && <p className="muted">{t('e2ee.waiting')}</p>}
      <p className="muted small-text">{t('e2ee.panel.metadata')}</p>
      {members.includes(myKey) && (
        <div className="e2ee-rekey">
          <button className="button" disabled={busy} onClick={() => void rekey()}>{t('e2ee.panel.rekey')}</button>
          <p className="muted small-text">{t('e2ee.panel.rekeyHint')}</p>
          {note && <p className="muted" role="status">{note}</p>}
        </div>
      )}
      {!!state?.restarts.length && (
        <div className="e2ee-history" data-testid="e2ee-history">
          <h3>{t('e2ee.startOver.history')}</h3>
          {state.restarts.map((at) => <p key={at} className="muted small-text">{restartRecord(at)}</p>)}
        </div>
      )}
      {verify && <SafetyNumberDialog me={myKey} peer={verify} onClose={() => setVerify(null)} />}
    </Modal>
  )
}

const restartRecord = (at: number) => t('e2ee.startOver.record', { date: formatDate(at, { dateStyle: 'medium', timeStyle: 'short' }) })

/**
 * The server shows a different chain while you're in this one. Never taken by itself: who signed it and how well you
 * know their keys, then an explicit "Start over" (with a safety-number confirmation when none of them is a known key).
 */
function StartOverSection({ server, channel, state, findings, onVerify }: {
  server: ServerState; channel: Channel; state: ChannelCrypto; findings: Finding[]; onVerify: (key: string) => void
}) {
  const { t } = useTranslation()
  const dms = useDms()
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const offer = state.offer!
  const myKey = server.me?.accountKey ?? ''
  const nameOf = (key: string) => server.members[key]?.name
  const contacts = new Set([...Object.keys(dms.friends), ...Object.keys(dms.conversations)].map(resolveKey))
  const check = checkStartOver(offer, state.members, myKey, {
    same: sameAccount, isContact: (k) => contacts.has(resolveKey(k)), nameOf,
    warned: (k) => findingsAbout(findings, k).some((f) => f.severity === 'high'),
  })
  const label = (key: string) => nameOf(key) ?? key.slice(0, 8)
  const trustText = { 'old-chain': t('e2ee.startOver.trustOld'), contact: t('e2ee.startOver.trustContact'), new: t('e2ee.startOver.trustNew') }

  async function go() {
    setBusy(true)
    setNote(null)
    try {
      await startOver(server.key, channel.id, offer.chain)
      setNote(t('e2ee.startOver.done'))
    } catch (e) {
      setNote(e2eeText(errorMessage(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="e2ee-start-over" data-testid="e2ee-start-over">
      <p className="e2ee-start-over-warning" role="alert">{t('e2ee.startOver.warning')}</p>
      <p className="muted small-text">{t('e2ee.startOver.explain')}</p>
      <h3>{t('e2ee.startOver.signedBy')}</h3>
      <ul className="e2ee-members" data-testid="e2ee-signers">
        {check.signers.map((s) => (
          <li key={s.key}>
            <span className="e2ee-member-name">{label(s.key)}{s.created && <span className="muted"> ({t('e2ee.startOver.created')})</span>}</span>
            <span className={`e2ee-trust ${s.trust}`}>{trustText[s.trust]}</span>
            {s.warning && <span className="e2ee-warn" title={t('e2ee.panel.warning')}>⚠</span>}
            <button className="link" onClick={() => onVerify(s.key)}>{t('e2ee.panel.safetyNumber')}</button>
          </li>
        ))}
      </ul>
      <p className="muted small-text">{t('e2ee.startOver.members', { names: offer.members.map((k) => (k === myKey ? t('e2ee.panel.you') : label(k))).join(', ') })}</p>
      {check.lookalikes.map((k) => <p key={k} className="error-text">{t('e2ee.startOver.lookalike', { name: label(k) })}</p>)}
      {check.blocked === 'not-listed' && <p className="muted">{t('e2ee.startOver.notListed')}</p>}
      {check.blocked === 'key-warning' && <p className="error-text">{t('e2ee.startOver.keyWarning')}</p>}
      {!check.blocked && (
        <>
          {check.confirm && (
            <label className="e2ee-confirm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {t('e2ee.startOver.confirm')}
            </label>
          )}
          <button className="button danger" disabled={busy || (check.confirm && !confirmed)} onClick={() => void go()}>{t('e2ee.startOver.button')}</button>
          <p className="muted small-text">{t('e2ee.startOver.keepsOld')}</p>
        </>
      )}
      {note && <p className="muted" role="status">{note}</p>}
    </section>
  )
}

/** In the channel: when you started its encryption over (so a later swap can't pass unnoticed). */
export function StartOverRecordLine({ server, channelId }: { server: ServerState; channelId: number }) {
  const channel = encryptedChannel(server.key, channelId)
  const at = useE2ee((s) => (channel ? s.channels[slotOf(server.key, channel.id)]?.restarts.at(-1) : undefined))
  if (!channel || !at) return null
  return <div className="e2ee-record muted" data-testid="e2ee-record"><Lock size={12} /> {restartRecord(at)}</div>
}

/** The composer's place while sending is off; with a start-over offer, a way to look at it. */
export function EncryptedWriteBlock({ server, channel, text }: { server: ServerState; channel: Channel; text: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const offer = useE2ee((s) => !!s.channels[slotOf(server.key, channel.id)]?.offer)
  return (
    <div className="composer read-only e2ee-waiting" data-testid="e2ee-waiting">
      <span>{offer ? t('e2ee.startOver.warning') : text}</span>
      {offer && <button className="button" onClick={() => setOpen(true)} data-testid="e2ee-review">{t('e2ee.startOver.review')}</button>}
      {open && <EncryptionDialog server={server} channel={channel} onClose={() => setOpen(false)} />}
    </div>
  )
}

/** Under a message of an encrypted channel: its decrypted attachments, or why it can't be shown. */
export function EncryptedBits({ message }: { message: Message }) {
  const shown = shownOf(message)
  if (!message.e2ee) return null
  if (!shown || shown.state === 'pending') return <div className="e2ee-note muted">{t('e2ee.message.pending')}</div>
  if (shown.state === 'error') {
    const noKey = shown.error === "This device doesn't have the key for this message." || shown.error === BEFORE_YOU_JOINED
    return <div className="e2ee-note muted" data-testid="e2ee-unreadable"><Lock size={12} /> {noKey ? t('e2ee.message.noKey') : t('e2ee.message.error')}</div>
  }
  return shown.files?.length ? <DmAttachments files={shown.files} /> : null
}

/** The composer's place in an encrypted channel this device can't write in yet. */
export function useEncryptedWriteBlock(server: ServerState, channelId: number): string | null {
  const channel = encryptedChannel(server.key, channelId)
  const state = useE2ee((s) => (channel ? s.channels[slotOf(server.key, channel.id)] : undefined))
  if (!channel) return null
  if (state?.problem) return t('e2ee.panel.problem', { problem: e2eeText(state.problem) })
  if (!state || !state.members.includes(server.me?.accountKey ?? '') || !state.hasKey) return t('e2ee.waiting')
  return null
}

/** For the create dialog: how many people could read it, and whether that fits. */
export function EncryptedCreateNote({ count }: { count: number }) {
  const { t } = useTranslation()
  return (
    <div className="e2ee-create-note">
      <p className="muted">{t('e2ee.create.hint')}</p>
      <p className="muted small-text">{t('e2ee.create.limits', { max: MAX_CHANNEL_MEMBERS })}</p>
      {count > MAX_CHANNEL_MEMBERS
        ? <p className="error-text">{t('e2ee.create.tooMany', { count, max: MAX_CHANNEL_MEMBERS })}</p>
        : <p className="muted">{t('e2ee.create.count', { count })}</p>}
    </div>
  )
}
