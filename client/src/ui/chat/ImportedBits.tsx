// How imported messages look: a label saying where they came from, reaction counts and files the export didn't include.
import { useTranslation } from 'react-i18next'
import type { Message } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { formatBytes } from '../../state/backups'
import { EmojiGlyph } from '../expressions/EmojiPicker'
import './imported.css'

export function ImportedBadge() {
  const { t } = useTranslation()
  return (
    <span className="imported-badge" title={t('chat.imported.title')}>
      {t('chat.imported.badge')}
    </span>
  )
}

/** Reactions as they were counted on Discord (people can still react here as usual). */
export function ImportedExtras({ server, message }: { server: ServerState; message: Message }) {
  const imported = message.imported
  const { t } = useTranslation()
  if (!imported) return null
  const { reactions, missingAttachments } = imported
  if (reactions.length === 0 && missingAttachments.length === 0) return null
  return (
    <>
      {missingAttachments.length > 0 && (
        <ul className="imported-missing" aria-label={t('chat.imported.missingFiles')}>
          {missingAttachments.map((file, i) => (
            <li key={i}>
              <span className="imported-missing-name">{file.name}</span>
              <span className="muted">{file.size > 0 ? `${formatBytes(file.size)} · ` : ''}{t('chat.imported.notIncluded')}</span>
            </li>
          ))}
        </ul>
      )}
      {reactions.length > 0 && (
        <div className="reactions imported-reactions" aria-label={t('chat.imported.reactions')}>
          {reactions.map((r) => (
            <span key={r.emoji} className="reaction static" title={t('chat.imported.reactionCount', { n: r.count })}>
              <EmojiGlyph serverKey={server.key} emoji={r.emoji} /> <span className="count">{r.count}</span>
            </span>
          ))}
        </div>
      )}
    </>
  )
}
