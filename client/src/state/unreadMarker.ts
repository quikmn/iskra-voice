// "Mark unread from here": the channel shows as unread again, and a "New" line sits above that message the next
// time you open it. Kept on this device only (read state isn't synced between devices).
import { create } from 'zustand'
import { activeChannelId, patchServer, useApp } from './store'

interface Marker {
  messageId: number
  /** Set once you've left the channel after marking; leaving again after coming back clears the marker. */
  armed: boolean
}

export const useUnreadMarkers = create<{ markers: Record<string, Marker> }>(() => ({ markers: {} }))

const tag = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

export function markUnread(serverKey: string, channelId: number, messageId: number): void {
  const server = useApp.getState().servers[serverKey]
  if (!server) return
  const count = (server.messages[channelId] ?? []).filter((m) => !m.tempId && m.id >= messageId).length
  patchServer(serverKey, (s) => ({ unread: { ...s.unread, [channelId]: Math.max(1, count) } }))
  useUnreadMarkers.setState((s) => ({ markers: { ...s.markers, [tag(serverKey, channelId)]: { messageId, armed: false } } }))
}

export const useUnreadMarker = (serverKey: string, channelId: number): number | null =>
  useUnreadMarkers((s) => s.markers[tag(serverKey, channelId)]?.messageId ?? null)

// Watch which channel is open, to arm and then clear markers.
let current: string | null = null
useApp.subscribe((state) => {
  const channel = activeChannelId(state)
  const now = state.activeServer && channel !== null ? tag(state.activeServer, channel) : null
  if (now === current) return
  const left = current
  current = now
  if (!left) return
  const marker = useUnreadMarkers.getState().markers[left]
  if (!marker) return
  useUnreadMarkers.setState((s) => {
    const markers = { ...s.markers }
    if (marker.armed) delete markers[left]
    else markers[left] = { ...marker, armed: true }
    return { markers }
  })
})
