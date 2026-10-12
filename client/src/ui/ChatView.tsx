import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../i18n/errors'
import type { FileInfo, Member } from '../core/protocol'
import {
  activeChannelId, connectionFor, discardFailed, loadHistory, notifyTyping, retryAll, retryFailed, sendMessage, useApp,
  type PendingMessage, type ServerState,
} from '../state/store'
import { Attachments, LinkPreviewCard, Reactions, ReactionPicker, ReplyLine } from './chat/MessageExtras'
import { AuthorAvatar, BotBadge, Embeds } from './chat/BotBits'
import { useCommandSuggest } from './chat/CommandSuggest'
import { authorOf, sameSender } from './chat/bots'
import { ImportedBadge, ImportedExtras } from './chat/ImportedBits'
import { firstLink, formatSize, replyKey, setReply, useReply } from './chat/helpers'
import { Avatar, Spinner } from './bits'
import { openProfileCard } from '../state/profile'
import { decodeMentions, encodeMentions, renderMarkdown } from './markdown'
import { clockTime, fullTime, hueFor, messageTime } from './format'
import { formatNumber } from '../i18n/format'
import type { Panel } from './Shell'
import { Close, FileIcon, Hash, Menu, Paperclip, Pencil, Reply, Send, Smile, Trash, Users, Volume, WifiOff } from './icons'
import { HeaderTools } from './chat/HeaderTools'
import { EncryptedBits, EncryptedWriteBlock, EncryptionButton, LockBadge, StartOverRecordLine, e2eeText, useEncryptedWriteBlock } from './e2ee/E2ee'
import { editEncrypted, isEncrypted, uploadFor } from '../state/e2eeChannels'
import { MessageActionSheet } from './chat/MessageActionSheet'
import { useLongPress } from './chat/useLongPress'
import { JumpToPresent, MessageMenuExtras, PinnedMark, PinNoteRow, ThreadSummary } from './chat/PinThreadBits'
import { withPinNotes } from './chat/pinThreadHelpers'
import { jumpToMessage, jumpToPresent, loadNewer, useJumpTarget } from '../state/jump'
import { pinNotesFor, usePinNotes } from '../state/pins'
import { decodeEmoji, encodeEmoji, insertAt } from './expressions/emoji'
import { useEmojiLookup } from './expressions/useEmojiLookup'
import { useEmojiSuggest } from './expressions/EmojiSuggest'
import { PollCard, PollDialog } from './expressions/Polls'
import { PollIcon } from './expressions/icons'
import { useServerEmojis } from '../state/expressions'
import { VoiceMessage, VoiceRecordButton } from './chat/voice/VoiceMessages'
import { voiceRecordingSupported, type Recording } from './chat/voice/recorder'
import { BlockGate, ChannelSettingsButton, SlowmodeChip, TimedOutBar } from './moderation/Moderation'
import { useSlowmodeWait, useTimedOut } from './moderation/hooks'
import { RulesBar } from './rules/Rules'
import { useMustAgree } from '../state/rules'
import { ForwardDialog, ForwardedLine, ForwardIcon } from './organize/ForwardDialog'
import { UnreadBar, UnreadDivider } from './organize/UnreadBits'
import { channelConv, dividerOf, dividerTarget, useRead } from '../state/readState'
import { useRoleLookup, useServerRoles } from '../state/roles'
import { canDeleteMessage, canMentionRole, canSendIn, has, nameColor } from '../state/permissions'
import { draftKey, setDraft, useDraft } from '../state/drafts'
import { MessageMoreButton } from './chat/MessageMore'
import { StickerMessage } from './chat/Stickers'
import { ExpressionPicker, GifMessage, type ExpressionTab } from './chat/ExpressionPicker'
import { sendGif } from '../state/gifs'
import { sendSticker } from '../state/stickers'
import { SpoilerToggle, isSpoilerName, longTextFile } from './chat/media'
import { AutoModAlertCard } from './automod/AutoModAlert'
import { userMenuProps } from './people/userMenuProps'
import { EditedMark } from './productivity/EditHistory'
import { useSendLater } from './productivity/SendLater'
import { ClipNoticeRow } from './clips/ClipNotice'
import { conversationLabel } from '../state/threads'
import { messageListKeys, useAnnounceNew } from './a11y'

const GROUP_WINDOW_MS = 5 * 60 * 1000

export function ChatView({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const channelId = useApp(activeChannelId)
  const channel = server.channels.find((c) => c.id === channelId)
  const roles = useServerRoles(server.key)
  const canWrite = !!channel && canSendIn(server.me, channel, roles)
  const writeBlock = useEncryptedWriteBlock(server, channel?.id ?? -1)
  const { t } = useTranslation()

  useEffect(() => {
    if (channelId !== null && server.status.state === 'online') void loadHistory(server.key, channelId)
  }, [server.key, channelId, server.status.state])

  const [dragging, setDragging] = useState(false)

  return (
    <div
      className={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        setDragging(false)
        if (!canWrite || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('iskra:attach', { detail: [...e.dataTransfer.files] }))
      }}
    >
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('chat.view.openChannels')}>
          <Menu />
        </button>
        {channel ? (
          <h1>
            <span className="hash">{channel.kind === 'voice' || channel.kind === 'stage' ? <Volume size={20} /> : <Hash size={20} />}</span>
            {channel.name}
            <LockBadge channel={channel} size={14} />
          </h1>
        ) : (
          <h1>{server.name}</h1>
        )}
        <span className="spacer" />
        <HeaderTools key={channel?.id} server={server} channel={channel} />
        <EncryptionButton server={server} channel={channel} />
        <ChannelSettingsButton server={server} channel={channel} />
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('chat.view.members')} title={t('chat.view.members')}>
          <Users />
        </button>
      </header>

      <ConnectionBanner server={server} />

      {channel ? (
        <>
          <StartOverRecordLine server={server} channelId={channel.id} />
          <MessageList key={channel.id} server={server} channelId={channel.id} />
          <TypingLine server={server} channelId={channel.id} />
          {canWrite && writeBlock ? (
            <EncryptedWriteBlock server={server} channel={channel} text={writeBlock} />
          ) : canWrite ? (
            <Composer server={server} channelId={channel.id} channelName={channel.name} />
          ) : (
            <div className="composer read-only">{t('chat.view.readOnly')}</div>
          )}
        </>
      ) : (
        <div className="empty-state">
          {server.status.state === 'online' ? (
            <>
              <span className="empty-icon"><Hash size={32} /></span>
              <h1>{t('chat.view.noChannels')}</h1>
              <p>{has(server.me, roles, 'manageChannels') ? t('chat.view.noChannelsAdmin') : t('chat.view.noChannelsMember')}</p>
            </>
          ) : <Spinner />}
        </div>
      )}
    </div>
  )
}

/** Plain words for a server that's away: reconnecting (with a "Try now"), or turned us away. */
function ConnectionBanner({ server }: { server: ServerState }) {
  const { status } = server
  const { t } = useTranslation()
  if (status.state === 'rejected') {
    return <div className="banner error" role="alert"><span>{errorMessage(status)}</span></div>
  }
  if (status.state !== 'offline') return null
  return (
    <div className="banner warn" role="status">
      <WifiOff size={16} />
      <span>{t(status.stopped ? 'chat.view.stopped' : 'chat.view.offline', { name: server.name })}</span>
      <button className="button small" onClick={retryAll}>{t('chat.view.tryNow')}</button>
    </div>
  )
}

export function MessageList({ server, channelId, header, thread }: { server: ServerState; channelId: number; header?: ReactNode; thread?: boolean }) {
  const messages = server.messages[channelId]
  const hasMore = server.hasMore[channelId]
  const detached = !!server.detached?.[channelId]
  const notes = usePinNotes(pinNotesFor(server.key, channelId))
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const restore = useRef<{ height: number; top: number } | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const conv = channelConv(server.key, channelId)
  const divider = dividerOf(useRead(conv))
  const { t } = useTranslation()

  // Up-arrow in an empty composer edits your last message.
  useEffect(() => {
    const onEditLast = () => {
      const mine = messages?.filter((m) => !m.tempId && m.author === server.me?.accountKey).at(-1)
      if (mine) setEditing(mine.id)
    }
    const event = thread ? 'iskra:edit-last-thread' : 'iskra:edit-last'
    window.addEventListener(event, onEditLast)
    return () => window.removeEventListener(event, onEditLast)
  }, [messages, server.me, thread])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (restore.current) {
      // Loaded older messages: keep what the user was looking at in place.
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top
      restore.current = null
    } else if (stickToBottom.current && !detached) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, detached])
  useJumpTarget(server.key, channelId, scroller, () => (stickToBottom.current = false), messages)
  useAnnounceNew(messages, (m) => (m.tempId ? null : String(m.id)), (m) => m.author === server.me?.accountKey ? null
    : t('chat.a11y.newMessage', { name: authorOf(m, server.members).name, text: m.text ? decodeMentions(m.text, (k) => server.members[k]?.name ?? null).slice(0, 200) : t('chat.message.attachment') }), !thread)

  function onScroll() {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (el.scrollTop < 200 && hasMore && !restore.current) {
      restore.current = { height: el.scrollHeight, top: el.scrollTop }
      void loadHistory(server.key, channelId, true)
    }
    if (detached && el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadNewer(server.key, channelId)
  }

  const rendered = useMemo(() => {
    if (!messages) return null
    return messages.map((message, i) => {
      const prev = messages[i - 1]
      const grouped = !!prev && sameSender(prev, message) && message.createdAt - prev.createdAt < GROUP_WINDOW_MS && !prev.pending
      return { message, grouped }
    })
  }, [messages])
  // The "New messages" divider goes above the first unread message, once it's loaded (older ones may still be on the server).
  const firstUnread = divider && messages && (!hasMore || messages.some((m) => !m.tempId && m.id <= (divider.from.id as number)))
    ? dividerTarget(messages, divider.from, (m) => (m.tempId ? null : { id: m.id, at: m.createdAt }))?.id ?? null
    : null

  if (!rendered) {
    return (
      <div className="messages loading">
        <Spinner />
      </div>
    )
  }

  return (
    <>
    <div className="messages" ref={scroller} onScroll={onScroll} onKeyDown={messageListKeys} tabIndex={0}
      role="region" aria-label={t('chat.a11y.messages', { name: conversationLabel(server, channelId) })}>
      <UnreadBar conv={conv} scroller={scroller} onJump={() => (stickToBottom.current = false)}
        catchUp={{ spec: { kind: 'channel', serverKey: server.key, channelId }, title: conversationLabel(server, channelId) }}
        loadOlder={() => loadHistory(server.key, channelId, true).then(() => !!useApp.getState().servers[server.key]?.hasMore[channelId])} />
      {!hasMore && (header ?? (
        <div className="channel-start">
          <span className="channel-start-icon" aria-hidden><Hash size={32} /></span>
          <p className="channel-start-title">{t('chat.view.welcome', { name: server.channels.find((c) => c.id === channelId)?.name ?? t('chat.view.thisChannel') })}</p>
          <p>{t('chat.view.channelStart')}</p>
        </div>
      ))}
      {withPinNotes(rendered, notes).map(({ message, grouped, note }) => note ? (
        <PinNoteRow key={`pin-${note.messageId}-${note.at}`} server={server} channelId={channelId} note={note} />
      ) : (
        <Fragment key={message.tempId ?? message.id}>
          {message.id === firstUnread && !message.tempId && <UnreadDivider main={!thread} />}
          {message.clip && !message.tempId ? <ClipNoticeRow server={server} message={message} /> : <BlockGate author={message.author}>
            <MessageRow
              server={server}
              message={message}
              grouped={grouped && message.id !== firstUnread}
              editing={editing === message.id}
              onEdit={(on) => setEditing(on ? message.id : null)}
            />
          </BlockGate>}
        </Fragment>
      ))}
    </div>
    {detached && (
      <JumpToPresent onClick={() => {
        stickToBottom.current = true
        void jumpToPresent(server.key, channelId)
      }} />
    )}
    </>
  )
}

function MessageRow({
  server, message, grouped, editing, onEdit,
}: {
  server: ServerState
  message: PendingMessage
  grouped: boolean
  editing: boolean
  onEdit: (on: boolean) => void
}) {
  const author: Member | undefined = server.members[message.author]
  const shown = authorOf(message, server.members)
  const name = shown.name
  const canOpenProfile = !message.webhook && !!server.members[message.author]
  const me = server.me
  const mine = me?.accountKey === message.author
  const roles = useServerRoles(server.key)
  const roleOf = useRoleLookup(server.key, me)
  const canDelete = !message.tempId && canDeleteMessage(me, message, author, roles)
  const authorColor = (!message.webhook && nameColor(author, roles)) || `hsl(${hueFor(message.author)} 70% var(--name-l))`
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [picking, setPicking] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [forwarding, setForwarding] = useState(false)
  const canForward = !message.tempId && !message.poll && !message.e2ee && (!!message.text || message.attachments.length > 0)
  const canEdit = mine && !!message.text && !message.poll
  const longPress = useLongPress(() => setSheet(true), !message.tempId && !editing)
  const [error, setError] = useState<string | null>(null)
  const emojiLookup = useEmojiLookup(server.key)
  const { t } = useTranslation()

  function jumpTo(id: number) {
    void jumpToMessage(server.key, message.channelId, id)
  }

  async function remove() {
    try {
      await connectionFor(server.key)?.request('chat.delete', { id: message.id })
    } catch (e) {
      setError(errorMessage(e))
    }
    setConfirmDelete(false)
  }

  return (
    <>
    <div
      id={message.tempId ? undefined : `msg-${message.id}`}
      className={`message ${grouped && !message.replyTo ? 'grouped' : ''} ${message.pending ?? ''} ${sheet ? 'pressed' : ''}`}
      role="article"
      tabIndex={-1}
      aria-label={t('chat.a11y.message', { name, time: fullTime(message.createdAt) })}
      {...longPress}
    >
      <div className="message-gutter">
        {grouped ? (
          <time className="hover-time" title={fullTime(message.createdAt)}>{clockTime(message.createdAt)}</time>
        ) : canOpenProfile ? (
          <button className="avatar-button" onClick={(e) => openProfileCard(server.key, message.author, e.currentTarget)} {...userMenuProps(message.author, server.key)} aria-label={t('chat.message.profileOf', { name })}>
            <AuthorAvatar server={server} author={shown} hueKey={message.author} />
          </button>
        ) : (
          <AuthorAvatar server={server} author={shown} hueKey={message.author} />
        )}
      </div>
      <div className="message-body">
        {message.replyTo && <ReplyLine server={server} reply={message.replyTo} onJump={jumpTo} />}
        {(!grouped || message.replyTo) && (
          <div className="message-meta">
            {canOpenProfile ? (
              <button className="author" style={{ color: authorColor }} onClick={(e) => openProfileCard(server.key, message.author, e.currentTarget)} {...userMenuProps(message.author, server.key)}>{name}</button>
            ) : (
              <span className="author" style={{ color: authorColor }}>{name}</span>
            )}
            {shown.bot && <BotBadge />}
            {message.imported && <ImportedBadge />}
            <time title={fullTime(message.createdAt)}>{messageTime(message.createdAt)}</time>
            {message.pinned && <PinnedMark />}
          </div>
        )}
        {message.forwarded && (
          <ForwardedLine
            label={message.forwarded.channelName ? `#${message.forwarded.channelName}` : null}
            onOpen={message.forwarded.channelId && message.forwarded.messageId
              ? () => void jumpToMessage(server.key, message.forwarded!.channelId!, message.forwarded!.messageId!) : undefined}
          />
        )}
        {editing ? (
          <EditBox server={server} message={message} onDone={() => onEdit(false)} />
        ) : (
          (message.text || message.editedAt) && !message.poll && (
            <div className="message-text">
              {renderMarkdown(message.text, { nameOf: (k) => server.members[k]?.name ?? null, me: me?.accountKey, emoji: emojiLookup, roleOf, serverKey: server.key })}
              <EditedMark server={server} message={message} />
            </div>
          )
        )}
        {message.poll && <PollCard server={server} message={message} />}
        {message.automod && <AutoModAlertCard server={server} alert={message.automod} />}
        {message.sticker && <StickerMessage server={server} sticker={message.sticker} />}
        {message.gif && <GifMessage server={server} gif={message.gif} />}
        {message.voice ? <VoiceMessage server={server} message={message} /> : <Attachments server={server} files={message.attachments} />}
        <EncryptedBits message={message} />
        {message.webhook && <Embeds server={server} embeds={message.webhook.embeds} />}
        {message.cards && message.cards.length > 0 && <Embeds server={server} embeds={message.cards} authorName={name} />}
        {!message.tempId && !message.e2ee && firstLink(message.text) && <LinkPreviewCard server={server} url={firstLink(message.text)!} />}
        <ImportedExtras server={server} message={message} />
        <Reactions server={server} message={message} />
        <ThreadSummary server={server} message={message} />
        {message.pending === 'failed' && message.blockedReason ? (
          <div className="message-failed" role="alert">
            {message.blockedReason}{' '}
            <button className="link" onClick={() => {
              const roleName = (id: number) => roles.find((r) => r.id === id)?.name ?? null
              setDraft(draftKey.channel(server.key, message.channelId), decodeEmoji(decodeMentions(message.text, (k) => server.members[k]?.name ?? null, roleName)))
              discardFailed(server.key, message.channelId, message.tempId!)
            }}>{t('common.edit')}</button>
            {' · '}
            <button className="link" onClick={() => discardFailed(server.key, message.channelId, message.tempId!)}>{t('chat.message.discard')}</button>
          </div>
        ) : message.pending === 'failed' && (
          <div className="message-failed">
            {t('chat.message.couldNotSend')}{' '}
            <button className="link" onClick={() => void retryFailed(server.key, message.channelId, message)}>{t('common.retry')}</button>
            {' · '}
            <button className="link" onClick={() => discardFailed(server.key, message.channelId, message.tempId!)}>{t('chat.message.discard')}</button>
          </div>
        )}
        {error && <div className="message-failed">{error}</div>}
      </div>
      {!editing && !message.tempId && (
        <div className={`message-actions ${picking ? 'open' : ''}`} role="toolbar" aria-label={t('chat.a11y.actions')}>
          {confirmDelete ? (
            <>
              <span>{t('chat.message.deleteConfirm')}</span>
              <button className="danger" onClick={() => void remove()}>{t('common.yes')}</button>
              <button onClick={() => setConfirmDelete(false)}>{t('common.no')}</button>
            </>
          ) : (
            <>
              <button onClick={() => setPicking((p) => !p)} title={t('chat.message.addReaction')} aria-label={t('chat.message.addReaction')}><Smile size={15} /></button>
              <button onClick={() => setReply(server.key, message.channelId, message)} title={t('chat.message.reply')} aria-label={t('chat.message.reply')}><Reply size={15} /></button>
              <MessageMenuExtras server={server} message={message} />
              {canForward && <button onClick={() => setForwarding(true)} title={t('chat.message.forward')} aria-label={t('chat.message.forward')}><ForwardIcon /></button>}
              <MessageMoreButton server={server} message={message} />
              {canEdit && <button onClick={() => onEdit(true)} title={t('common.edit')} aria-label={t('common.edit')}><Pencil size={15} /></button>}
              {canDelete && <button onClick={() => setConfirmDelete(true)} title={t('common.delete')} aria-label={t('common.delete')}><Trash size={15} /></button>}
            </>
          )}
          {picking && <ReactionPicker server={server} message={message} onClose={() => setPicking(false)} />}
        </div>
      )}
      {sheet && (
        <MessageActionSheet server={server} message={message} canEdit={canEdit} canDelete={canDelete} onEdit={() => onEdit(true)} onClose={() => setSheet(false)}
          onForward={canForward ? () => setForwarding(true) : undefined} />
      )}
      {forwarding && <ForwardDialog server={server} message={message} onClose={() => setForwarding(false)} />}
    </div>
    </>
  )
}

function EditBox({ server, message, onDone }: { server: ServerState; message: PendingMessage; onDone: () => void }) {
  const roles = useServerRoles(server.key)
  const original = decodeEmoji(decodeMentions(message.text, (k) => server.members[k]?.name ?? null, (id) => roles.find((r) => r.id === id)?.name ?? null))
  const emojis = useServerEmojis(server.key)
  const [text, setText] = useState(original)
  const [error, setError] = useState<string | null>(null)
  const { t } = useTranslation()

  async function save() {
    const trimmed = text.trim()
    if (!trimmed || trimmed === original) return onDone()
    try {
      const encoded = encodeEmoji(encodeMentions(trimmed, Object.values(server.members), roles.filter((r) => canMentionRole(server.me ?? undefined, r, roles))), emojis)
      if (message.e2ee) await editEncrypted(server.key, message, encoded)
      else await connectionFor(server.key)?.request('chat.edit', { id: message.id, text: encoded })
      onDone()
    } catch (e) {
      setError(e2eeText(errorMessage(e)))
    }
  }

  return (
    <div className="edit-box">
      <AutoTextarea
        value={text}
        onChange={setText}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          }
        }}
      />
      <div className="edit-hint">
        {t('chat.message.editHint')} {error && <span className="error-text">· {error}</span>}
      </div>
    </div>
  )
}

interface PendingUpload {
  localId: string
  file: File
  preview: string | null
  progress: number
  result: FileInfo | null
  error: string | null
  abort: AbortController
}

export function Composer({ server, channelId, channelName, thread, placeholder }: {
  server: ServerState
  channelId: number
  channelName: string
  thread?: boolean
  placeholder?: string
}) {
  const [uploads, setUploads] = useState<PendingUpload[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const [pickerTab, setPickerTab] = useState<ExpressionTab>('emoji')
  const openPicker = (anchor: HTMLElement, tab: ExpressionTab) => {
    if (picker && pickerTab === tab) return setPicker(null)
    setPickerTab(tab)
    setPicker(anchor)
  }
  const [pollOpen, setPollOpen] = useState(false)
  const emojis = useServerEmojis(server.key)
  const replyTo = useReply((s) => s.replyTo[replyKey(server.key, channelId)] ?? null)
  const text = useDraft(draftKey.channel(server.key, channelId))
  const online = server.status.state === 'online'
  // While the server restarts you can keep writing: sends wait as "sending" and go out once it's back.
  const writable = online || server.status.state === 'restarting'
  const setText = (value: string) => setDraft(draftKey.channel(server.key, channelId), value)
  const uploading = uploads.some((u) => !u.result && !u.error)
  const ready = uploads.filter((u) => u.result).map((u) => u.result!)
  const slowmode = useSlowmodeWait(server, channelId)
  const timedOut = useTimedOut(server)
  const mustAgree = useMustAgree(server.key)
  const canSend = writable && !uploading && slowmode.wait === 0 && (text.trim().length > 0 || ready.length > 0)

  function startUpload(item: PendingUpload) {
    const update = (patch: Partial<PendingUpload>) =>
      setUploads((list) => list.map((u) => (u.localId === item.localId ? { ...u, ...patch } : u)))
    uploadFor(server.key, channelId, item.file, (progress) => update({ progress }), item.abort.signal)
      .then((result) => update({ result, progress: 1 }))
      .catch((e: Error) => e.name !== 'AbortError' && update({ error: errorMessage(e) }))
  }

  function addFiles(files: File[]) {
    for (const file of files.slice(0, 10)) {
      const item: PendingUpload = {
        localId: `${Date.now()}-${Math.random()}`, file, progress: 0, result: null, error: null, abort: new AbortController(),
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      }
      setUploads((list) => [...list, item])
      startUpload(item)
    }
  }

  /** Spoilers travel in the file name (SPOILER_…), so toggling uploads the file again under the new name. */
  function toggleSpoiler(item: PendingUpload) {
    item.abort.abort()
    const name = isSpoilerName(item.file.name) ? item.file.name.replace(/^SPOILER_/, '') : `SPOILER_${item.file.name}`
    const next: PendingUpload = {
      ...item, file: new File([item.file], name, { type: item.file.type }), progress: 0, result: null, error: null, abort: new AbortController(),
    }
    setUploads((list) => list.map((u) => (u.localId === item.localId ? next : u)))
    startUpload(next)
  }

  function removeUpload(item: PendingUpload) {
    item.abort.abort()
    if (item.preview) URL.revokeObjectURL(item.preview)
    setUploads((list) => list.filter((u) => u.localId !== item.localId))
  }

  useEffect(() => {
    const onAttach = (e: Event) => addFiles((e as CustomEvent<File[]>).detail)
    const event = thread ? 'iskra:attach-thread' : 'iskra:attach'
    window.addEventListener(event, onAttach)
    return () => window.removeEventListener(event, onAttach)
  })

  // @mention autocomplete: the word being typed after "@".
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const query = /(?:^|\s)@([^\s@]{0,32})$/u.exec(text.slice(0, caret))?.[1]
  const roles = useServerRoles(server.key)
  const mentionableRoles = roles.filter((r) => canMentionRole(server.me ?? undefined, r, roles))
  const suggestions: { key: string; name: string; member?: Member; color?: string | null }[] = query === undefined ? [] : [
    ...Object.values(server.members)
      .filter((m) => [m.name, m.profileName ?? m.name].some((n) => n.toLowerCase().startsWith(query.toLowerCase())) && m.accountKey !== server.me?.accountKey)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .slice(0, 6)
      .map((m) => ({ key: m.accountKey, name: m.name, member: m })),
    ...mentionableRoles
      .filter((r) => r.name.toLowerCase().startsWith(query.toLowerCase()))
      .slice(0, 3)
      .map((r) => ({ key: `role-${r.id}`, name: r.name, color: r.color })),
  ]
  const later = useSendLater({
    target: { kind: 'channel', server: server.key, channelId, replyTo: replyTo?.id },
    prepare: () => (text.trim() ? encodeEmoji(encodeMentions(text.trim(), Object.values(server.members), mentionableRoles), emojis) : null),
    blocked: uploads.length > 0 ? t('productivity.sendLater.noFiles') : null,
    disabled: !online,
    onScheduled: () => {
      setText('')
      setReply(server.key, channelId, null)
    },
  })
  const emojiSuggest = useEmojiSuggest(server.key, text, caret, (next) => {
    setText(next.text)
    setCaret(next.caret)
  })
  const commandSuggest = useCommandSuggest(server.key, channelId, isEncrypted(server.key, channelId), text, caret, (next) => {
    setText(next.text)
    setCaret(next.caret)
  })

  function insertMention(name: string) {
    const before = text.slice(0, caret).replace(/@([^\s@]{0,32})$/u, `@${name} `)
    setText(before + text.slice(caret))
    setCaret(before.length)
    setPick(0)
  }

  async function sendVoice(recording: Recording) {
    const file = await uploadFor(server.key, channelId, recording.file, () => {})
    setReply(server.key, channelId, null)
    if (server.detached?.[channelId]) await jumpToPresent(server.key, channelId)
    await sendMessage(server.key, channelId, '', { attachments: [file], replyTo, voice: { duration: recording.duration, waveform: recording.waveform } })
  }

  function submit() {
    if (!canSend) return
    const trimmed = encodeEmoji(encodeMentions(text.trim(), Object.values(server.members), mentionableRoles), emojis)
    setText('')
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview)
    setUploads([])
    setReply(server.key, channelId, null)
    const send = () => void sendMessage(server.key, channelId, trimmed, { attachments: ready, replyTo })
    // Looking at older messages after a jump: go back to the present first.
    if (server.detached?.[channelId]) void jumpToPresent(server.key, channelId).then(send)
    else send()
  }

  if (timedOut) return <TimedOutBar server={server} />
  if (mustAgree) return <RulesBar server={server} />

  return (
    <div className="composer-wrap">
      {replyTo && (
        <div className="reply-bar">
          <span><Trans i18nKey="chat.composer.replyingTo" values={{ name: replyTo.imported?.name ?? server.members[replyTo.author]?.name ?? t('chat.composer.someone') }} components={{ b: <strong /> }} /></span>
          <button className="icon-button small" onClick={() => setReply(server.key, channelId, null)} aria-label={t('chat.composer.cancelReply')}><Close size={14} /></button>
        </div>
      )}
      {uploads.length > 0 && (
        <div className="pending-uploads">
          {uploads.map((u) => (
            <div key={u.localId} className={`pending-upload ${u.error ? 'failed' : ''}`} title={u.error ?? u.file.name}>
              {u.preview ? <img src={u.preview} alt="" className={isSpoilerName(u.file.name) ? 'spoiler-preview' : undefined} /> : <span className="file-icon" aria-hidden><FileIcon size={20} /></span>}
              <span className="file-name">{u.file.name}</span>
              {!u.error && <SpoilerToggle on={isSpoilerName(u.file.name)} onToggle={() => toggleSpoiler(u)} />}
              {u.error
                ? <span className="upload-error" role="alert">{u.error}</span>
                : <span className="muted">{u.result ? formatSize(u.file.size) : formatNumber(u.progress, { style: 'percent', maximumFractionDigits: 0 })}</span>}
              {!u.result && !u.error && <span className="upload-progress" style={{ width: `${u.progress * 100}%` }} />}
              <button className="icon-button small" onClick={() => removeUpload(u)} aria-label={t('chat.composer.removeFile', { name: u.file.name })}><Close size={14} /></button>
            </div>
          ))}
        </div>
      )}
    <div className="composer">
      <button className="icon-button attach-button" onClick={() => fileInput.current?.click()} aria-label={t('chat.composer.attach')} title={t('chat.composer.attach')} disabled={!online}>
        <Paperclip />
      </button>
      {!isEncrypted(server.key, channelId) && (
        <button className="icon-button attach-button" onClick={() => setPollOpen(true)} aria-label={t('chat.composer.poll')} title={t('chat.composer.poll')} disabled={!online}>
          <PollIcon />
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      {emojiSuggest.popup}
      {commandSuggest.popup}
      {suggestions.length > 0 && (
        <div className="mention-popup" role="listbox" aria-label={t('chat.composer.mention')}>
          {suggestions.map((m, i) => (
            <button
              key={m.key}
              role="option"
              aria-selected={i === pick % suggestions.length}
              className={i === pick % suggestions.length ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                insertMention(m.name)
              }}
            >
              {m.member
                ? <Avatar name={m.name} accountKey={m.member.accountKey} size={24} online={m.member.online} />
                : <span className="mention-role-icon" style={m.color ? { color: m.color } : undefined} aria-hidden>@</span>}
              {m.name}
              {!m.member && <span className="muted mention-kind">{t('chat.composer.role')}</span>}
            </button>
          ))}
        </div>
      )}
      <AutoTextarea
        key={channelId}
        value={text}
        onCaret={setCaret}
        aria={commandSuggest.inputProps}
        autoFocus
        placeholder={writable ? (placeholder ?? t('chat.composer.placeholder', { name: channelName })) : t('chat.composer.reconnecting')}
        maxLength={4000}
        onChange={(value) => {
          setText(value)
          if (value) notifyTyping(server.key, channelId)
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length) {
            e.preventDefault()
            addFiles(files)
            return
          }
          // Too long for one message: send it as a text file instead (like Discord's message.txt).
          const pasted = e.clipboardData.getData('text')
          if (text.length + pasted.length > 4000) {
            e.preventDefault()
            addFiles([longTextFile(pasted)])
          }
        }}
        onKeyDown={(e) => {
          if (emojiSuggest.onKeyDown(e)) return
          if (commandSuggest.onKeyDown(e)) return
          if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
          } else if (suggestions.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault()
            insertMention(suggestions[pick % suggestions.length].name)
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          } else if (e.key === 'ArrowUp' && !text) {
            e.preventDefault()
            window.dispatchEvent(new Event(thread ? 'iskra:edit-last-thread' : 'iskra:edit-last'))
          } else if (e.key === 'Escape' && replyTo) {
            e.preventDefault()
            setReply(server.key, channelId, null)
          }
        }}
      />
      <button className="icon-button attach-button gif-button" onClick={(e) => openPicker(e.currentTarget, 'gifs')} aria-label={t('chat.composer.gifs')} title={t('chat.composer.gifs')} disabled={!online}>
        GIF
      </button>
      <button className="icon-button attach-button" onClick={(e) => openPicker(e.currentTarget, 'emoji')} aria-label={t('chat.composer.emoji')} title={t('chat.composer.emojiTitle')}>
        <Smile />
      </button>
      {!text.trim() && uploads.length === 0 && voiceRecordingSupported() && <VoiceRecordButton onSend={sendVoice} disabled={!online} />}
      <SlowmodeChip seconds={slowmode.seconds} wait={slowmode.wait} />
      {later.button}
      <button className="send-button" onClick={submit} disabled={!canSend} aria-label={t('common.send')} {...later.sendProps}>
        <Send />
      </button>
    </div>
      {later.dialog}
      {picker && (
        <ExpressionPicker
          key={pickerTab}
          server={server}
          anchor={picker}
          initialTab={pickerTab}
          onClose={() => setPicker(null)}
          onEmoji={(value) => {
            const next = insertAt(text, caret, decodeEmoji(value))
            setText(next.text)
            setCaret(next.caret)
          }}
          onGif={(gif) => {
            setReply(server.key, channelId, null)
            void sendGif(server.key, channelId, gif, { replyTo })
          }}
          onSticker={(sticker) => {
            setReply(server.key, channelId, null)
            void sendSticker(server.key, channelId, sticker, { replyTo })
          }}
        />
      )}
      {pollOpen && <PollDialog server={server} channelId={channelId} onClose={() => setPollOpen(false)} />}
    </div>
  )
}

function AutoTextarea({
  value, onChange, onKeyDown, onPaste, onCaret, placeholder, autoFocus, maxLength, aria,
}: {
  value: string
  aria?: React.AriaAttributes
  onChange: (v: string) => void
  onCaret?: (position: number) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  autoFocus?: boolean
  maxLength?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      maxLength={maxLength}
      onChange={(e) => {
        onChange(e.target.value)
        onCaret?.(e.target.selectionStart)
      }}
      onSelect={(e) => onCaret?.(e.currentTarget.selectionStart)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      {...aria}
    />
  )
}

export function TypingLine({ server, channelId }: { server: ServerState; channelId: number }) {
  const [now, setNow] = useState(() => Date.now())
  const entries = server.typing[channelId] ?? {}
  const { t } = useTranslation()
  const active = Object.entries(entries).filter(([key, until]) => until > now && key !== server.me?.accountKey)

  useEffect(() => {
    if (active.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active.length])

  const names = active.map(([key]) => server.members[key]?.name ?? t('common.someone'))
  const text =
    names.length === 0 ? '' : names.length === 1 ? t('chat.typing.one', { name: names[0] })
      : names.length <= 3 ? t('chat.typing.some', { names: names.join(', ') }) : t('chat.typing.many')
  return <div className="typing-line" aria-live="polite">{text}</div>
}

