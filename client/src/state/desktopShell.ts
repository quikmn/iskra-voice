// Desktop app glue: iskra:// invite links. (The unread badge lives with the title badge in notify.ts.)
import { parseInvite } from '../core/invite'
import { desktop } from '../platform/desktop'
import { useApp } from './store'

/** An invite token from the desktop app becomes the usual "You're invited" prompt. */
function openInviteToken(token: string): void {
  const invite = parseInvite(token)
  if (invite) useApp.setState({ pendingInvite: invite })
}

export function startDesktopLinks(): () => void {
  if (!desktop?.onDeepLink) return () => {}
  void desktop.takeDeepLink().then((token) => token && openInviteToken(token), () => undefined)
  return desktop.onDeepLink(openInviteToken)
}
