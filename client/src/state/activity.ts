// Activity status ("Playing X"): the desktop app detects the game, this sends its name to every server.
import { desktop } from '../platform/desktop'
import { connectionFor, onWelcomeHook, useApp } from './store'

let current: string | null = null

function send(serverKey: string): void {
  // Servers without activity support answer unknown_type: fine, they just won't show it.
  connectionFor(serverKey)?.request('activity.set', { name: current }).catch(() => undefined)
}

function apply(game: string | null): void {
  if (game === current) return
  current = game
  for (const key of Object.keys(useApp.getState().servers)) send(key)
}

// After (re)connecting, the server has forgotten it: tell it again.
onWelcomeHook((serverKey) => {
  if (current) send(serverKey)
})

export function startActivity(): () => void {
  if (!desktop?.onActivity) return () => {}
  void desktop.activity().then((game) => apply(game), () => undefined)
  return desktop.onActivity(apply)
}

/** "12 min", "1 h 5 min": how long an activity has been going. */
export function elapsed(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 1) return 'just started'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
}
