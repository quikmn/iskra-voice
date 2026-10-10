// The chat plus, when open, a side panel with a thread or search results.
import { useEffect } from 'react'
import { activeChannelId, useApp, type ServerState } from '../../state/store'
import { closeThread, useThreads } from '../../state/threads'
import { useSearch } from '../../state/search'
import { ChatView } from '../ChatView'
import type { Panel } from '../Shell'
import { SearchPanel } from './SearchPanel'
import { ThreadPanel } from './ThreadPanel'
import { ForumView } from '../forums/ForumView'
import './chat-extras.css'

export function ChatArea({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const channelId = useApp(activeChannelId)
  const open = useThreads((s) => (s.open?.key === server.key ? s.open : null))
  const thread = useThreads((s) => (open ? s.threads[server.key]?.[open.id] : undefined))
  const searching = useSearch((s) => s.key === server.key)
  const threadOpen = !!open && (!thread || thread.channelId === channelId)
  const forum = server.channels.find((c) => c.id === channelId && c.kind === 'forum')

  // A thread belongs to its channel: going to another channel closes it.
  useEffect(() => {
    if (open && thread && thread.channelId !== channelId) closeThread()
  }, [open, thread, channelId])

  return (
    <div className={`chat-area ${threadOpen || searching ? 'has-panel' : ''}`}>
      {forum ? <ForumView key={forum.id} server={server} channel={forum} onToggle={onToggle} /> : <ChatView server={server} onToggle={onToggle} />}
      {threadOpen ? <ThreadPanel key={open.id} server={server} threadId={open.id} /> : searching ? <SearchPanel server={server} /> : null}
    </div>
  )
}
