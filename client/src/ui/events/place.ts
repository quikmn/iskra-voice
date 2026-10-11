import type { ServerEvent } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { t } from '../../i18n'

/** Where an event is, in words ("lounge" for a voice channel here, or the text). */
export function placeOf(server: ServerState, event: ServerEvent): { label: string; voiceId: number | null } {
  if (event.location.kind === 'place') return { label: event.location.text, voiceId: null }
  const channel = server.channels.find((c) => c.id === (event.location as { channelId: number | null }).channelId)
  return channel ? { label: channel.name, voiceId: channel.id } : { label: t('events.aVoiceChannel'), voiceId: null }
}
