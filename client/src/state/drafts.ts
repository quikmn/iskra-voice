// Unsent text per conversation (a channel, a thread or a DM), kept on this device so it survives switching
// servers, closing the app and reloading.
import { create } from 'zustand'

const KEY = 'iskra.drafts'
const MAX_DRAFTS = 200

type Drafts = Record<string, { text: string; at: number }>

function load(): Drafts {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Drafts
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export const useDrafts = create<{ drafts: Drafts }>(() => ({ drafts: load() }))

let timer: ReturnType<typeof setTimeout> | null = null
function save(): void {
  timer ??= setTimeout(() => {
    timer = null
    try {
      localStorage.setItem(KEY, JSON.stringify(useDrafts.getState().drafts))
    } catch {
      /* private mode or full */
    }
  }, 400)
}

export const draftKey = {
  channel: (serverKey: string, channelId: number) => `c:${serverKey}:${channelId}`,
  dm: (peer: string) => `dm:${peer}`,
}

export function setDraft(key: string, text: string): void {
  useDrafts.setState(({ drafts }) => {
    const next = { ...drafts }
    if (text) next[key] = { text, at: Date.now() }
    else delete next[key]
    // Keep the newest ones.
    const keys = Object.keys(next)
    if (keys.length > MAX_DRAFTS) keys.sort((a, b) => next[a].at - next[b].at).slice(0, keys.length - MAX_DRAFTS).forEach((k) => delete next[k])
    return { drafts: next }
  })
  save()
}

/** Drops drafts (a channel that's gone: its unsent text goes with it). */
export function forgetDrafts(keys: string[]): void {
  if (!keys.some((k) => k in useDrafts.getState().drafts)) return
  useDrafts.setState(({ drafts }) => {
    const next = { ...drafts }
    for (const k of keys) delete next[k]
    return { drafts: next }
  })
  save()
}

export const useDraft = (key: string): string => useDrafts((s) => s.drafts[key]?.text ?? '')
