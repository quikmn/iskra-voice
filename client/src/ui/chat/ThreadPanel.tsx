// A thread beside its channel (full screen on phones): the message it started from, its replies, a composer.
import { useEffect, useState } from 'react'
import { prepareChannel, readable } from '../../state/e2eeChannels'
import { alertPatternFor } from '../../state/alerts'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { Message } from '../../core/protocol'
import { useRoleLookup, useServerRoles } from '../../state/roles'
import { canSendIn, has, outranks } from '../../state/permissions'
import { connectionFor, loadHistory, type ServerState } from '../../state/store'
import { closeThread, deleteThread, renameThread, rememberThreads, useThreads } from '../../state/threads'
import { Composer, MessageList, TypingLine } from '../ChatView'
import { Avatar, Spinner } from '../bits'
import { fullTime, hueFor, messageTime } from '../format'
import { renderMarkdown } from '../markdown'
import { Close, Pencil, Trash } from '../icons'
import { Attachments } from './MessageExtras'
import { PinList, Popover } from './HeaderTools'
import { ArrowLeft, PinIcon, ThreadIcon } from './extraIcons'
import { openProfileCard } from '../../state/profile'
import { useEscapeLayer } from '../layers'
import { replyBlock } from '../../state/forums'
import { PostBar } from '../forums/PostBar'
import { useForumPost } from '../forums/useForumPost'
import { resolveKey } from '../../state/keyMap'
import { userMenuProps } from '../people/userMenuProps'

export function ThreadPanel({ server, threadId }: { server: ServerState; threadId: number }) {
  const thread = useThreads((s) => s.threads[server.key]?.[threadId])
  const [root, setRoot] = useState<Message | null | undefined>(undefined)
  const [missing, setMissing] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pinsOpen, setPinsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const online = server.status.state === 'online'
  const { t } = useTranslation()
  useEscapeLayer(closeThread)

  // The thread and the message it started from.
  useEffect(() => {
    if (!online) return
    let alive = true
    connectionFor(server.key)?.request('thread.get', { id: threadId })
      .then(async (r) => {
        if (!alive) return
        rememberThreads(server.key, [r.thread])
        if (r.root?.e2ee) await prepareChannel(server.key, r.root.channelId).catch(() => {})
        if (alive) setRoot(r.root && readable(server.key, r.root))
      })
      .catch(() => alive && setMissing(true))
    return () => {
      alive = false
    }
  }, [server.key, threadId, online])

  useEffect(() => {
    if (online) void loadHistory(server.key, threadId)
  }, [server.key, threadId, online])

  const parent = thread ? server.channels.find((c) => c.id === thread.channelId) : undefined
  const me = server.me
  const post = useForumPost(server, threadId, parent?.kind)
  const blocked = replyBlock(server, post)
  const isPost = parent?.kind === 'forum'
  const roles = useServerRoles(server.key)
  const canWrite = !!parent && canSendIn(me, parent, roles)
  const creator = thread ? server.members[thread.createdBy] : undefined
  const canManage = !!me && !!thread && (thread.createdBy === me.accountKey ||
    (has(me, roles, 'manageMessages') && (!creator || outranks(me, creator, roles))))
  // Prefer the live copy of the root message when its channel is loaded.
  const liveRoot = thread ? server.messages[thread.channelId]?.find((m) => m.id === thread.rootId && !m.tempId) : undefined
  const shownRoot = liveRoot ?? root

  async function saveName() {
    const name = renaming?.trim()
    if (!name || !thread || name === thread.name) return setRenaming(null)
    try {
      await renameThread(server.key, thread.id, name)
      setRenaming(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function remove() {
    try {
      await deleteThread(server.key, threadId)
      closeThread()
    } catch (e) {
      setError(errorMessage(e))
      setConfirmDelete(false)
    }
  }

  return (
    <section
      className="side-panel thread-panel"
      aria-label={thread ? t('chat.threads.label', { name: thread.name }) : t('chat.threads.thread')}
      onDragOver={(e) => {
        if (canWrite && e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!canWrite || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('iskra:attach-thread', { detail: [...e.dataTransfer.files] }))
      }}
    >
      <header className="side-panel-header">
        <button className="icon-button panel-back" onClick={closeThread} aria-label={t('chat.threads.backToChannel')}><ArrowLeft /></button>
        <span className="panel-icon"><ThreadIcon /></span>
        {renaming !== null ? (
          <input
            className="thread-rename"
            value={renaming}
            maxLength={100}
            autoFocus
            aria-label={t('chat.threads.name')}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveName()
              else if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(null)
              }
            }}
            onBlur={() => void saveName()}
          />
        ) : (
          <div className="panel-title">
            <h2>{thread?.name ?? t('chat.threads.thread')}</h2>
            {parent && <span className="muted">{t('chat.threads.inChannel', { name: parent.name })}</span>}
          </div>
        )}
        <span className="spacer" />
        {thread && (
          <button className={`icon-button ${pinsOpen ? 'on' : ''}`} onClick={() => setPinsOpen((v) => !v)} aria-label={isPost ? t('chat.threads.pinnedInPost') : t('chat.threads.pinnedHere')} title={isPost ? t('chat.threads.pinnedInPost') : t('chat.header.pins')}>
            <PinIcon />
          </button>
        )}
        {canManage && renaming === null && !confirmDelete && (
          <>
            <button className="icon-button" onClick={() => setRenaming(thread!.name)} aria-label={isPost ? t('chat.threads.renamePost') : t('chat.threads.renameThread')} title={t('chat.threads.rename')}><Pencil size={16} /></button>
            <button className="icon-button" onClick={() => setConfirmDelete(true)} aria-label={isPost ? t('chat.threads.deletePost') : t('chat.threads.deleteThread')} title={isPost ? t('chat.threads.deletePost') : t('chat.threads.deleteThread')}><Trash size={16} /></button>
          </>
        )}
        {confirmDelete && (
          <span className="confirm-inline">
            {isPost ? t('chat.threads.deletePostConfirm') : t('chat.threads.deleteThreadConfirm')}
            <button className="button danger small" onClick={() => void remove()}>{t('common.delete')}</button>
            <button className="button small" onClick={() => setConfirmDelete(false)}>{t('chat.threads.keep')}</button>
          </span>
        )}
        <button className="icon-button panel-close" onClick={closeThread} aria-label={t('chat.threads.close')} title={t('common.close')}><Close /></button>
        {pinsOpen && thread && (
          <Popover title={t('chat.threads.pinnedIn', { name: thread.name })} onClose={() => setPinsOpen(false)}>
            <PinList server={server} channelId={thread.id} onJump={() => setPinsOpen(false)} />
          </Popover>
        )}
      </header>
      {error && <div className="banner error">{error}</div>}
      {post && <PostBar server={server} post={post} />}

      {missing ? (
        <div className="empty-state"><p>{t('chat.threads.missing')}</p></div>
      ) : (
        <>
          <MessageList
            key={threadId}
            server={server}
            channelId={threadId}
            thread
            header={<ThreadStart server={server} root={shownRoot} createdBy={thread?.createdBy} post={parent?.kind === 'forum'} />}
          />
          <TypingLine server={server} channelId={threadId} />
          {canWrite && thread && !blocked ? (
            <Composer server={server} channelId={threadId} channelName={thread.name} thread placeholder={isPost ? t('chat.threads.replyPost') : t('chat.threads.replyThread')} />
          ) : (
            <div className="composer read-only">{blocked ?? (thread ? t('chat.threads.cannotReply') : <Spinner />)}</div>
          )}
        </>
      )}
    </section>
  )
}

/** The message the thread started from, at the top of the thread. */
function ThreadStart({ server, root, createdBy, post }: { server: ServerState; root: Message | null | undefined; createdBy?: string; post?: boolean }) {
  const roleOf = useRoleLookup(server.key, server.me)
  const { t } = useTranslation()
  if (root === undefined) return <div className="thread-start"><Spinner /></div>
  const starter = createdBy ? server.members[createdBy]?.name ?? t('common.someone') : null
  if (root === null) {
    return (
      <div className="thread-start">
        <p className="muted">{t('chat.threads.rootDeleted')}</p>
        {starter && <p className="muted">{post ? t('chat.threads.startedPost', { name: starter }) : t('chat.threads.startedThread', { name: starter })}</p>}
      </div>
    )
  }
  const name = root.imported?.name ?? (server.members[root.author] ?? server.members[resolveKey(root.author)])?.name ?? t('chat.author.formerMember')
  return (
    <div className="thread-start">
      <div className="thread-root">
        <Avatar name={name} accountKey={root.author} size={36} />
        <div className="message-body">
          <div className="message-meta">
            {server.members[root.author] ? (
              <button className="author" style={{ color: `hsl(${hueFor(root.author)} 70% var(--name-l))` }} onClick={(e) => openProfileCard(server.key, root.author, e.currentTarget)} {...userMenuProps(root.author, server.key)}>{name}</button>
            ) : (
              <span className="author" style={{ color: `hsl(${hueFor(root.author)} 70% var(--name-l))` }}>{name}</span>
            )}
            <time title={fullTime(root.createdAt)}>{messageTime(root.createdAt)}</time>
          </div>
          {root.text && (
            <div className="message-text">
              {renderMarkdown(root.text, { nameOf: (k) => server.members[k]?.name ?? null, me: server.me?.accountKey, roleOf, serverKey: server.key, alerts: alertPatternFor(server.key) })}
            </div>
          )}
          <Attachments server={server} files={root.attachments} />
        </div>
      </div>
      {starter && !post && <p className="muted thread-started-by">{t('chat.threads.startedHint', { name: starter })}</p>}
    </div>
  )
}
