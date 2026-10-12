// Phone app glue (mobile/): links that open the app, saving files, status bar colours and voice in the background
// (nativeVoice.ts). Nothing happens in a browser.
import { parseInvite } from '../core/invite'
import { native, nativeLinkTarget } from '../platform/native'
import { startNativeVoice } from './nativeVoice'
import { usePendingLink } from './link'
import { useApp } from './store'

function openUrl(url: string): void {
  const target = nativeLinkTarget(url)
  if (target?.kind === 'link') usePendingLink.setState({ code: target.code })
  if (target?.kind === 'invite') {
    const invite = parseInvite(target.token)
    if (invite) useApp.setState({ pendingInvite: invite })
  }
}

/**
 * The web view can't save a download="…" link to a blob (decrypted DM files, exported themes, calendar files),
 * so those go to the share sheet instead. Links to server files open in Safari, which saves them itself.
 */
function onClick(event: MouseEvent): void {
  if (!native || event.defaultPrevented) return
  const link = (event.target as Element | null)?.closest?.('a[download]')
  if (!(link instanceof HTMLAnchorElement) || !/^(blob|data):/.test(link.href)) return
  event.preventDefault()
  const name = link.getAttribute('download') || 'file'
  void fetch(link.href)
    .then((response) => response.blob())
    .then((blob) => native!.saveFile(blob, name))
    .catch(() => undefined)
}

/** Light status bar text on dark themes, dark on light ones (theme.ts sets data-scheme). */
function followTheme(): () => void {
  const root = document.documentElement
  let last: string | null = null
  const apply = () => {
    const scheme = root.dataset.scheme === 'light' ? 'light' : 'dark'
    if (scheme === last) return
    last = scheme
    void native!.setStatusBar(scheme).catch(() => undefined)
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(root, { attributes: true, attributeFilter: ['data-scheme'] })
  return () => observer.disconnect()
}

export function startNativeShell(): () => void {
  if (!native) return () => {}
  const stopLinks = native.onOpenUrl(openUrl)
  const stopTheme = followTheme()
  const stopVoice = startNativeVoice()
  document.addEventListener('click', onClick, true)
  return () => {
    stopLinks()
    stopTheme()
    stopVoice()
    document.removeEventListener('click', onClick, true)
  }
}
