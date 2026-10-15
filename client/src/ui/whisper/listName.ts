import type { ServerState } from '../../state/store'
import type { WhisperList } from '../../state/whisper'

/** A list's name as shown in buttons: its own name, the channel, or the first people on it. */
export function listName(list: WhisperList, server: ServerState | undefined, fallback: string): string {
  if (list.name.trim()) return list.name.trim()
  if (list.target?.kind === 'channel') {
    const channel = server?.channels.find((c) => c.id === (list.target as { channelId: number }).channelId)
    return channel ? `#${channel.name}` : fallback
  }
  if (list.target?.kind === 'people') {
    const names = list.target.people.map((k) => server?.members[k]?.name).filter(Boolean) as string[]
    if (names.length) return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')
  }
  return fallback
}
