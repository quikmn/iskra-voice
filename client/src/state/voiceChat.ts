// The text chat beside a voice or stage call: whether the panel is open. Read state treats it like any channel on
// screen (state/readState.ts), so opening it reads what came in.
import { create } from 'zustand'
import { channelConv, setShown } from './readState'
import { selectChannel } from './store'
import { setStageOpen, useVoice } from './voice'

export const useVoiceChat = create<{ open: boolean }>(() => ({ open: false }))

export const setVoiceChatOpen = (open: boolean): void => useVoiceChat.setState({ open })
export const toggleVoiceChat = (): void => setVoiceChatOpen(!useVoiceChat.getState().open)

/** The panel is showing this channel's chat (or nothing): what the read state counts as on screen. */
export function showVoiceChat(serverKey: string | null, channelId: number | null): void {
  setShown('voice-chat', serverKey && channelId !== null ? channelConv(serverKey, channelId) : null)
}

/**
 * The chat button on a voice channel's row: in that call, the call screen with the chat beside it; otherwise the
 * channel's chat on its own, without joining.
 */
export function openVoiceChannelChat(serverKey: string, channelId: number): void {
  const session = useVoice.getState().session
  if (session && !session.call && !session.group && session.serverKey === serverKey && session.channelId === channelId) {
    setStageOpen(true)
    setVoiceChatOpen(true)
    return
  }
  setStageOpen(false)
  selectChannel(serverKey, channelId)
}
