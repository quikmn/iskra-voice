// How imported messages look: a label saying where they came from, reaction counts and files the export didn't include.
import type { Message } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { formatBytes } from '../../state/backups'
import { EmojiGlyph } from '../expressions/EmojiPicker'
import './imported.css'

export function ImportedBadge() {
  return (
    <span className="imported-badge" title="Imported from Discord. This person isn't an Iskra account here.">
      Imported from Discord
    </span>
  )
}

/** Reactions as they were counted on Discord (people can still react here as usual). */
export function ImportedExtras({ server, message }: { server: ServerState; message: Message }) {
  const imported = message.imported
  if (!imported) return null
  const { reactions, missingAttachments } = imported
  if (reactions.length === 0 && missingAttachments.length === 0) return null
  return (
    <>
      {missingAttachments.length > 0 && (
        <ul className="imported-missing" aria-label="Files not included in the import">
          {missingAttachments.map((file, i) => (
            <li key={i}>
              <span className="imported-missing-name">{file.name}</span>
              <span className="muted">{file.size > 0 ? `${formatBytes(file.size)} · ` : ''}not included in the export</span>
            </li>
          ))}
        </ul>
      )}
      {reactions.length > 0 && (
        <div className="reactions imported-reactions" aria-label="Reactions on Discord">
          {reactions.map((r) => (
            <span key={r.emoji} className="reaction static" title={`${r.count} on Discord`}>
              <EmojiGlyph serverKey={server.key} emoji={r.emoji} /> <span className="count">{r.count}</span>
            </span>
          ))}
        </div>
      )}
    </>
  )
}
