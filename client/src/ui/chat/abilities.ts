// What you may do with a message beyond replying and reacting.
import { roleRank } from '../../core/protocol'
import type { PendingMessage, ServerState } from '../../state/store'
import { canPin } from '../../state/pins'
import { isThreadId } from '../../state/threads'

/** Whether you may pin this message, and start a thread from it. */
export function pinThreadAbilities(server: ServerState, message: PendingMessage): { pinnable: boolean; threadable: boolean } {
  if (message.tempId) return { pinnable: false, threadable: false }
  const inThread = isThreadId(server, message.channelId)
  const channel = server.channels.find((c) => c.id === message.channelId)
  const canWrite = !!server.me && !!channel && roleRank(server.me.role) >= roleRank(channel.writeRole)
  return { pinnable: canPin(server, message.channelId), threadable: !inThread && canWrite && !message.thread }
}
