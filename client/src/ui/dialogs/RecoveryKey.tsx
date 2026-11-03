import { useState } from 'react'
import { create } from 'zustand'
import { useTranslation } from 'react-i18next'
import { t } from '../../i18n'
import { encodeRecoveryKey, seedOf } from '../../core/recovery'
import { markRecoverySaved, useApp } from '../../state/store'
import { buildInviteLink } from '../../core/invite'
import { Modal } from '../bits'
import { appUrl } from '../format'
import { Close, Key } from '../icons'

function useRecoveryKey(): string | null {
  const identity = useApp((s) => s.identity)
  return identity ? encodeRecoveryKey(seedOf(identity)) : null
}

/** Links back to your servers. Members get in with any link; "returning" isn't a real invite code. */
function serverLines(): string[] {
  const { servers, order } = useApp.getState()
  const lines = order
    .map((key) => servers[key])
    .filter((s) => s?.me)
    .map((s) => `  ${s.name}: ${buildInviteLink(appUrl(s.appUrl), { serverUrl: s.directUrl, serverKey: s.key, code: 'returning' })}`)
  return lines.length ? ['', t('settings.recovery.file.servers'), ...lines] : []
}

function download(key: string, name: string) {
  const text = [
    t('settings.recovery.file.title'),
    '',
    key,
    '',
    t('settings.recovery.file.account', { name }),
    t('settings.recovery.file.warning'),
    t('settings.recovery.file.howTo'),
    ...serverLines(),
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: 'iskra-recovery-key.txt' })
  link.click()
  URL.revokeObjectURL(url)
}

export function KeyActions({ recoveryKey }: { recoveryKey: string }) {
  const { t } = useTranslation()
  const name = useApp((s) => s.profile?.name ?? '')
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-row">
      <button
        className="button"
        onClick={async () => {
          await navigator.clipboard.writeText(recoveryKey)
          setCopied(true)
          void markRecoverySaved()
        }}
      >
        {copied ? t('settings.recovery.copied') : t('common.copy')}
      </button>
      <button
        className="button"
        onClick={() => {
          download(recoveryKey, name)
          void markRecoverySaved()
        }}
      >
        {t('settings.recovery.downloadFile')}
      </button>
    </div>
  )
}

export function RecoveryKeySection() {
  const { t } = useTranslation()
  const recoveryKey = useRecoveryKey()
  const [shown, setShown] = useState(false)
  if (!recoveryKey) return null
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.recovery')}</h2>
      <p className="muted">{t('settings.recovery.intro')}</p>
      {shown ? (
        <>
          <div className="recovery-key">{recoveryKey}</div>
          <KeyActions recoveryKey={recoveryKey} />
          <p className="warning-text">{t('keys.newKey.warning')}</p>
        </>
      ) : (
        <button className="button" onClick={() => setShown(true)}>{t('settings.recovery.show')}</button>
      )}
    </section>
  )
}

// "Later" on the reminder: it steps back to a dot on the me bar's avatar and a row in the status menu, and comes back
// as a banner after a week (or on another device, which never said "Later").
const LATER_KEY = 'iskra.recoveryLater'
const LATER_FOR_MS = 7 * 24 * 60 * 60 * 1000

function readLater(): number {
  try {
    return Number(localStorage.getItem(LATER_KEY)) || 0
  } catch {
    return 0
  }
}

const useNudge = create<{ laterAt: number; open: boolean }>(() => ({ laterAt: readLater(), open: false }))

function snooze(): void {
  const now = Date.now()
  try {
    localStorage.setItem(LATER_KEY, String(now))
  } catch { /* this session only */ }
  useNudge.setState({ laterAt: now })
}

/** Shows the recovery key (from the status menu's row). */
export const openRecoveryKey = (): void => useNudge.setState({ open: true })

/** The key isn't saved yet and there's an account worth keeping: `banner` while it's not snoozed, `quiet` after "Later". */
export function useRecoveryDue(): 'banner' | 'quiet' | null {
  const saved = useApp((s) => s.profile?.recoverySaved)
  const hasServer = useApp((s) => s.order.length > 0)
  const hasKey = useApp((s) => !!s.identity)
  const laterAt = useNudge((s) => s.laterAt)
  if (saved || !hasServer || !hasKey) return null
  return Date.now() - laterAt < LATER_FOR_MS ? 'quiet' : 'banner'
}

/** A gentle reminder until the key has been saved once: one slim line at the top of the main column. */
export function RecoveryNudge() {
  const { t } = useTranslation()
  const due = useRecoveryDue()
  const open = useNudge((s) => s.open)
  const close = () => useNudge.setState({ open: false })
  const recoveryKey = useRecoveryKey()
  // The dialog stays open once the key is saved (it says "Copied"); the banner and the dot go.
  if (!recoveryKey || (!due && !open)) return null

  return (
    <>
      {due === 'banner' && (
        <div className="nudge" role="status">
          <span className="nudge-icon" aria-hidden><Key size={16} /></span>
          <p>{t('settings.recovery.nudge')}</p>
          <button className="button primary small" onClick={openRecoveryKey}>{t('settings.recovery.saveIt')}</button>
          <button className="button ghost small nudge-later" onClick={snooze} aria-label={t('settings.recovery.later')} title={t('settings.recovery.later')}>
            <span className="nudge-later-text">{t('settings.recovery.later')}</span>
            <span className="nudge-later-icon" aria-hidden><Close size={16} /></span>
          </button>
        </div>
      )}
      {open && (
        <Modal title={t('settings.recovery.yourKey')} onClose={close}>
          <p className="muted">{t('settings.recovery.keepSafe')}</p>
          <div className="recovery-key">{recoveryKey}</div>
          <KeyActions recoveryKey={recoveryKey} />
          <p className="warning-text">{t('keys.newKey.warning')}</p>
        </Modal>
      )}
    </>
  )
}
