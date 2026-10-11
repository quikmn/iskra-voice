// In a DM: "safety number changed" after the person replaced their account key, and a warning while it's disputed.
import { Trans, useTranslation } from 'react-i18next'
import type { Dm } from '../../state/dms'
import { nameOf } from '../../state/dms'
import { useKeys } from '../../state/keys'
import { keysOf } from '../../state/keyMap'
import { DmKtWarning } from './KeyTransparency'
import { fullTime, messageTime } from '../format'
import { Lock } from '../icons'
import './keys.css'

export function DmKeyNotice({ dm, onVerify }: { dm: Dm; onVerify: () => void }) {
  const { t } = useTranslation()
  const name = nameOf(dm.from)
  return (
    <div className={`dm-key-notice ${dm.notice === 'key-disputed' ? 'disputed' : ''}`} role="note" data-testid="key-notice">
      <Lock size={13} />
      <span>
        <Trans i18nKey="keys.notice.changed" values={{ name, when: messageTime(dm.sentAt) }} components={{ time: <time title={fullTime(dm.sentAt)} /> }} />
        {dm.notice === 'key-disputed' && ` ${t('keys.notice.disputed')}`}
      </span>
      <button className="link" onClick={onVerify}>{t('keys.notice.verify')}</button>
    </div>
  )
}

/** Two keys claimed this person's old key (on a server, or across servers). */
export function DmKeyWarning({ peer }: { peer: string }) {
  const disputed = useKeys((s) => (s.disputes[peer]?.length ?? 0) > 0)
  const conflicted = useKeys((s) => keysOf(peer).some((k) => (s.conflicts[k]?.length ?? 0) > 1))
  const { t } = useTranslation()
  if (!disputed && !conflicted) return <DmKtWarning peer={peer} />
  return (
    <div className="dm-key-warning" role="alert">
      {t('keys.notice.twoKeys', { name: nameOf(peer) })}
    </div>
  )
}
