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
import { DocsView } from '../docs/DocsView'
import { WhiteboardView } from '../whiteboard/WhiteboardView'
import { MediaView } from '../mediaChannels/MediaView'
import { TasksView } from '../tasks/TasksView'
import { TaskPanel } from '../tasks/TaskPanel'
import { PhotosView } from '../photos/PhotosView'
import './chat-extras.css'

export function ChatArea({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const channelId = useApp(activeChannelId)
  const open = useThreads((s) => (s.open?.key === server.key ? s.open : null))
  const thread = useThreads((s) => (open ? s.threads[server.key]?.[open.id] : undefined))
  const searching = useSearch((s) => s.key === server.key)
  const threadOpen = !!open && (!thread || thread.channelId === channelId)
  const forum = server.channels.find((c) => c.id === channelId && c.kind === 'forum')
  const docs = server.channels.find((c) => c.id === channelId && c.kind === 'docs')
  const board = server.channels.find((c) => c.id === channelId && c.kind === 'whiteboard')
  // A media channel shows its open post in its own viewer, with the comments beside the picture.
  const media = server.channels.find((c) => c.id === channelId && c.kind === 'media')
  // A task board shows its open task (a thread) in its own panel.
  const tasks = server.channels.find((c) => c.id === channelId && c.kind === 'tasks')
  // A photos channel shows a photo's comments (a thread) in its own viewer.
  const photos = server.channels.find((c) => c.id === channelId && c.kind === 'photos')

  // A thread belongs to its channel: going to another channel closes it.
  useEffect(() => {
    if (open && thread && thread.channelId !== channelId) closeThread()
  }, [open, thread, channelId])

  return (
    <div className={`chat-area ${(threadOpen && !media && !photos) || searching ? 'has-panel' : ''}`}>
      {media ? <MediaView key={media.id} server={server} channel={media} onToggle={onToggle} />
        : forum ? <ForumView key={forum.id} server={server} channel={forum} onToggle={onToggle} />
        : docs ? <DocsView key={docs.id} server={server} channel={docs} onToggle={onToggle} />
        : board ? <WhiteboardView key={board.id} server={server} channel={board} onToggle={onToggle} />
        : tasks ? <TasksView key={tasks.id} server={server} channel={tasks} onToggle={onToggle} />
        : photos ? <PhotosView key={photos.id} server={server} channel={photos} onToggle={onToggle} />
        : <ChatView server={server} onToggle={onToggle} />}
      {threadOpen && tasks ? <TaskPanel key={open.id} server={server} channel={tasks} taskId={open.id} />
        : threadOpen && !media && !photos ? <ThreadPanel key={open.id} server={server} threadId={open.id} /> : searching ? <SearchPanel server={server} /> : null}
    </div>
  )
}
