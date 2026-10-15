// Messages as something to translate: plain text (no markup), their conversation, and the servers that may have the models.
import type { Message } from '../../core/protocol'
import { sharedServers, type Dm } from '../../state/dms'
import type { ServerState } from '../../state/store'
import { convKey, type TranslateItem } from '../../state/translate'
import { plainText } from '../markdown'

/** A channel, thread or forum message as something to translate (null: nothing to translate). */
export function channelItem(server: ServerState, message: Message): TranslateItem | null {
  if (!message.text || message.poll || message.builtin) return null
  const text = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null })
  return text.trim() ? { conv: convKey.channel(server.key, message.channelId), id: String(message.id), text, servers: [server.key] } : null
}

/** A DM as something to translate. */
export function dmItem(peer: string, dm: Dm, nameOf: (key: string) => string | null): TranslateItem | null {
  if (!dm.text || dm.error || dm.call) return null
  const text = plainText(dm.text, { nameOf })
  return text.trim() ? { conv: convKey.dm(peer), id: dm.id, text, servers: sharedServers(peer) } : null
}

/** A group DM message ("<serverKey>/<groupId>"). */
export function groupItem(groupKey: string, id: string, raw: string, nameOf: (key: string) => string | null): TranslateItem | null {
  const text = raw ? plainText(raw, { nameOf }) : ''
  return text.trim() ? { conv: convKey.group(groupKey), id, text, servers: [groupKey.split('/')[0]] } : null
}
