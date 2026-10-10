import { useMemo } from 'react'
import { serverFileUrl, useServerEmojis } from '../../state/expressions'

/** Lookup for the markdown renderer: emoji id → image URL. */
export function useEmojiLookup(serverKey: string): (id: string) => string | null {
  const emojis = useServerEmojis(serverKey)
  return useMemo(() => {
    const byId = new Map(emojis.map((e) => [e.id, e]))
    return (id: string) => serverFileUrl(serverKey, byId.get(id)?.url ?? null)
  }, [emojis, serverKey])
}
