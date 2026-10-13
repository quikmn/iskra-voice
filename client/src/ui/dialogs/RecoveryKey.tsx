import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from '../../i18n'
import { encodeRecoveryKey, seedOf } from '../../core/recovery'
import { markRecoverySaved, useApp } from '../../state/store'
import { buildInviteLink } from '../../core/invite'
import { Modal } from '../bits'
import { appUrl } from '../format'

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

/** A gentle reminder until the key has been saved once. */
export function RecoveryNudge() {
  const { t } = useTranslation()
  const saved = useApp((s) => s.profile?.recoverySaved)
  const hasServer = useApp((s) => s.order.length > 0)
  const [later, setLater] = useState(false)
  const [open, setOpen] = useState(false)
  const recoveryKey = useRecoveryKey()
  if (saved || later || !hasServer || !recoveryKey) return null

  return (
    <>
      <div className="nudge" role="status">
        <p>{t('settings.recovery.nudge')}</p>
        <button className="button primary small" onClick={() => setOpen(true)}>{t('settings.recovery.saveIt')}</button>
        <button className="button small" onClick={() => setLater(true)}>{t('settings.recovery.later')}</button>
      </div>
      {open && (
        <Modal title={t('settings.recovery.yourKey')} onClose={() => setOpen(false)}>
          <p className="muted">{t('settings.recovery.keepSafe')}</p>
          <div className="recovery-key">{recoveryKey}</div>
          <KeyActions recoveryKey={recoveryKey} />
          <p className="warning-text">{t('keys.newKey.warning')}</p>
        </Modal>
      )}
    </>
  )
}
