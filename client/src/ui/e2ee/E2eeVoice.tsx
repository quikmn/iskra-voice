// Encrypted voice channels in the call UI: the "Encrypted voice" badge (call bar and call screen), its explanation,
// and the mark on someone whose media arrives unencrypted (and so isn't played).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../../state/store'
import { useVoice } from '../../state/voice'
import { useE2eeVoice } from '../../state/e2eeVoice'
import { Lock } from '../icons'
import { EncryptionDialog } from './E2ee'

/** The voice channel you're in, when it's end-to-end encrypted. */
function useEncryptedVoice() {
  const session = useVoice((s) => s.session)
  const server = useApp((s) => (session && !session.call && !session.group ? s.servers[session.serverKey] : undefined))
  const channel = server?.channels.find((c) => c.id === session?.channelId && c.e2ee)
  return server && channel && session ? { server, channel, session } : null
}

/** "Encrypted voice": grey while the keys are still going in, green once our media is encrypted. Opens the details. */
export function EncryptedVoiceBadge({ variant }: { variant: 'bar' | 'stage' }) {
  const { t } = useTranslation()
  const here = useEncryptedVoice()
  const version = useE2eeVoice((s) => s.version)
  const [open, setOpen] = useState(false)
  if (!here) return null
  const active = !!here.session.encrypted && here.session.state === 'connected'
  const title = [t('e2ee.voice.explain'), version ? t('e2ee.voice.version', { version }) : null].filter(Boolean).join('\n\n')
  return (
    <>
      <button
        type="button"
        className={`e2ee-voice-badge in-${variant} ${active ? '' : 'pending'}`}
        title={title}
        aria-label={`${active ? t('e2ee.voice.badge') : t('e2ee.voice.pending')}. ${t('e2ee.voice.explain')}`}
        onClick={() => setOpen(true)}
        data-testid="e2ee-voice"
        data-active={active}
        data-version={version ?? ''}
      >
        <Lock size={12} />
        <span>{active ? t('e2ee.voice.badge') : t('e2ee.voice.pending')}</span>
      </button>
      {open && <EncryptionDialog server={here.server} channel={here.channel} onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * On someone's tile in an encrypted voice channel: a small lock once their media arrives encrypted, or a warning when
 * something they publish isn't (the app doesn't play it).
 */
export function PeerEncryptionMark({ accountKey, name }: { accountKey: string; name: string }) {
  const { t } = useTranslation()
  const flagged = useE2eeVoice((s) => s.unencrypted.includes(accountKey))
  const encrypted = useE2eeVoice((s) => s.encrypted.includes(accountKey))
  if (!flagged) {
    if (!encrypted) return null
    return <span className="e2ee-peer-lock" role="img" title={t('e2ee.voice.badge')} aria-label={t('e2ee.voice.badge')} data-testid="e2ee-peer-encrypted"><Lock size={11} /></span>
  }
  const text = t('e2ee.voice.notEncrypted', { name })
  return <span className="e2ee-unencrypted" role="img" title={text} aria-label={text} data-testid="e2ee-unencrypted">!</span>
}
