import { useState } from 'react'
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
    .map((s) => `  ${s.name}: ${buildInviteLink(appUrl(s.appUrl), { serverUrl: s.url, serverKey: s.key, code: 'returning' })}`)
  return lines.length ? ['', 'Your servers (after restoring, open a link to get back in):', ...lines] : []
}

function download(key: string, name: string) {
  const text = [
    'Iskra recovery key',
    '',
    key,
    '',
    `Account: ${name}`,
    'Anyone with this key can use your account. Keep it somewhere safe (a password manager is ideal).',
    'To restore: open Iskra on any device, choose "I already have an account", and paste the key.',
    ...serverLines(),
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: 'iskra-recovery-key.txt' })
  link.click()
  URL.revokeObjectURL(url)
}

function KeyActions({ recoveryKey }: { recoveryKey: string }) {
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
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <button
        className="button"
        onClick={() => {
          download(recoveryKey, name)
          void markRecoverySaved()
        }}
      >
        Download as a file
      </button>
    </div>
  )
}

export function RecoveryKeySection() {
  const recoveryKey = useRecoveryKey()
  const [shown, setShown] = useState(false)
  if (!recoveryKey) return null
  return (
    <section className="settings-section">
      <h3>Recovery key</h3>
      <p className="muted">
        Your account lives on your devices, not on a server. This key is how you get it back on a new device or after clearing your browser.
      </p>
      {shown ? (
        <>
          <div className="recovery-key">{recoveryKey}</div>
          <KeyActions recoveryKey={recoveryKey} />
          <p className="warning-text">Anyone with this key can use your account. Never share it.</p>
        </>
      ) : (
        <button className="button" onClick={() => setShown(true)}>Show recovery key</button>
      )}
    </section>
  )
}

/** A gentle reminder until the key has been saved once. */
export function RecoveryNudge() {
  const saved = useApp((s) => s.profile?.recoverySaved)
  const hasServer = useApp((s) => s.order.length > 0)
  const [later, setLater] = useState(false)
  const [open, setOpen] = useState(false)
  const recoveryKey = useRecoveryKey()
  if (saved || later || !hasServer || !recoveryKey) return null

  return (
    <>
      <div className="nudge" role="status">
        <p>Save your recovery key, so you never lose your account.</p>
        <button className="button primary small" onClick={() => setOpen(true)}>Save it</button>
        <button className="button small" onClick={() => setLater(true)}>Later</button>
      </div>
      {open && (
        <Modal title="Your recovery key" onClose={() => setOpen(false)}>
          <p className="muted">Keep this somewhere safe, like a password manager. You'll need it to use your account on a new device.</p>
          <div className="recovery-key">{recoveryKey}</div>
          <KeyActions recoveryKey={recoveryKey} />
          <p className="warning-text">Anyone with this key can use your account. Never share it.</p>
        </Modal>
      )}
    </>
  )
}
