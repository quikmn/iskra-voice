// Pop-outs and picture-in-picture, the parts without a DOM: which kind of window a pop-out gets here, and which
// pop-outs have to close because what they show is gone (left the call, the stream stopped, the channel went).

/** What a pop-out shows: the voice/call panel, one stream (a camera or screen share tile), or a text channel. */
export type PopoutTarget =
  | { kind: 'voice' }
  | { kind: 'stream'; tileId: string }
  | { kind: 'chat'; serverKey: string; channelId: number }
export type PopoutKind = PopoutTarget['kind']

/**
 * window: a window of its own (desktop app). document: the browser's Document Picture-in-Picture window (Chromium).
 * video: the browser's picture-in-picture for one <video> (streams only, where Document PiP is missing).
 */
export type PopoutMode = 'window' | 'document' | 'video'

export interface PopoutEnv {
  /** The desktop app can open pop-out windows. */
  desktopWindows: boolean
  /** window.documentPictureInPicture exists. */
  documentPip: boolean
  /** document.pictureInPictureEnabled. */
  videoPip: boolean
  /** The phone apps: no pop-outs (their web views have neither kind of picture-in-picture). */
  phoneApp: boolean
}

/** How a pop-out of this kind opens here, or null when it can't (the button stays hidden). */
export function popoutMode(kind: PopoutKind, env: PopoutEnv): PopoutMode | null {
  if (env.phoneApp) return null
  if (env.desktopWindows) return 'window'
  // A text channel needs a real window; in the browser it's a tab away anyway.
  if (kind === 'chat') return null
  if (env.documentPip) return 'document'
  return kind === 'stream' && env.videoPip ? 'video' : null
}

export const targetKey = (t: PopoutTarget): string =>
  t.kind === 'voice' ? 'voice' : t.kind === 'stream' ? `stream:${t.tileId}` : `chat:${t.serverKey}:${t.channelId}`

/** window.open's name for it; the desktop app only makes windows for names like this (desktop/src/popouts.ts). */
export const popoutName = (kind: PopoutKind, n: number): string => `iskra-popout-${kind}-${n.toString(36)}`

/** Sizes asked of the browser's picture-in-picture window. */
export const PIP_SIZE: Record<PopoutKind, { width: number; height: number }> = {
  voice: { width: 280, height: 340 },
  stream: { width: 480, height: 300 },
  chat: { width: 380, height: 560 },
}

export interface Showing {
  /** In a voice channel or call right now. */
  inVoice: boolean
  /** The video tiles in the call. */
  tileIds: ReadonlySet<string>
  channelExists: (serverKey: string, channelId: number) => boolean
}

/** The pop-outs whose call, stream or channel is gone: they close. */
export function stalePopouts(open: readonly { id: string; target: PopoutTarget }[], now: Showing): string[] {
  return open.filter(({ target }) =>
    target.kind === 'voice' ? !now.inVoice
    : target.kind === 'stream' ? !now.inVoice || !now.tileIds.has(target.tileId)
    : !now.channelExists(target.serverKey, target.channelId)).map((p) => p.id)
}
