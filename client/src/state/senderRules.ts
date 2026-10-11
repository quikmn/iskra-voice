// Rules about message senders that feature modules fill in (blocks, roles), so store.ts and notify.ts
// can ask without importing them (they import store.ts themselves).
import type { Message } from '../core/protocol'
import { canPingGroups, mentions } from '../ui/markdown'
import type { ServerState } from './store'

export const senderRules = {
  /** Messages from this person don't count as unread or mentions and never notify (you blocked them). */
  ignored: (_accountKey: string): boolean => false,
  /** Whether @here counts for me (not while I'm invisible); presence fills it in. */
  hereCounts: (): boolean => true,
  /** Whether the author's @everyone/@here counts. */
  canPingGroups: (server: ServerState, message: Message): boolean =>
    canPingGroups(server.members[message.author]?.role, !!message.webhook),
  /** Does the message mention me (directly, a group, or one of my roles)? */
  mentionsMe: (server: ServerState, message: Message): boolean =>
    !!server.me && mentions(message.text, server.me.accountKey, senderRules.canPingGroups(server, message), senderRules.hereCounts()),
}
