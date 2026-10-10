// In a DM: "safety number changed" after the person replaced their account key, and a warning while it's disputed.
import type { Dm } from '../../state/dms'
import { nameOf } from '../../state/dms'
import { useKeys } from '../../state/keys'
import { keysOf } from '../../state/keyMap'
import { fullTime, messageTime } from '../format'
import { Lock } from '../icons'
import './keys.css'

export function DmKeyNotice({ dm, onVerify }: { dm: Dm; onVerify: () => void }) {
  const name = nameOf(dm.from)
  return (
    <div className={`dm-key-notice ${dm.notice === 'key-disputed' ? 'disputed' : ''}`} role="note" data-testid="key-notice">
      <Lock size={13} />
      <span>
        {name}'s account key changed <time title={fullTime(dm.sentAt)}>{messageTime(dm.sentAt)}</time>, so your safety number changed.
        {dm.notice === 'key-disputed' && ' Someone else claimed the same old key too.'}
      </span>
      <button className="link" onClick={onVerify}>Verify</button>
    </div>
  )
}

/** Two keys claimed this person's old key (on a server, or across servers). */
export function DmKeyWarning({ peer }: { peer: string }) {
  const disputed = useKeys((s) => (s.disputes[peer]?.length ?? 0) > 0)
  const conflicted = useKeys((s) => keysOf(peer).some((k) => (s.conflicts[k]?.length ?? 0) > 1))
  if (!disputed && !conflicted) return null
  return (
    <div className="dm-key-warning" role="alert">
      Two different keys claim to be {nameOf(peer)}: one of them may be someone who stole their old key. Check your safety number with them in
      person or on a call before sharing anything private.
    </div>
  )
}
