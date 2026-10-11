import { useEffect } from 'react'
import type { ForumPost } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { fetchPost, useForums } from '../../state/forums'

/** The forum post behind a thread id, fetched if the panel was opened from elsewhere (a link, a notification). */
export function useForumPost(server: ServerState, threadId: number, parentKind: string | undefined): ForumPost | undefined {
  const post = useForums((s) => s.posts[server.key]?.[threadId])
  const online = server.status.state === 'online'
  useEffect(() => {
    if (parentKind === 'forum' && !post && online) void fetchPost(server.key, threadId)
  }, [parentKind, post, online, server.key, threadId])
  return parentKind === 'forum' ? post : undefined
}
