// Everything around a message's text: attachments, the message it replies to, reactions.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileInfo, LinkPreview, Message, ReplyPreview } from '../../core/protocol'
import { formatSize, QUICK_REACTIONS } from './helpers'
import { connectionFor, fileUrl, toggleReaction, type ServerState } from '../../state/store'
import { ImageGrid, Lightbox, SpoilerCover, TextFilePreview, isSpoilerName, isTextFile, shownName } from './media'
import { EmojiGlyph, EmojiPicker } from '../expressions/EmojiPicker'
import { SmilePlus } from '../expressions/icons'
import { useEscapeLayer } from '../layers'
import { FileIcon } from '../icons'
import { plainText } from '../markdown'
import { ReactionsDialog } from './MessageMore'
import { EMBED_FRAME, embedFor, type Embed } from './embeds'
import { setAlwaysLoad, siteName, useAlwaysLoads } from '../../state/siteConsent'

/** Images as a grid that opens the gallery; videos, audio, text previews and other files below. Spoilers stay covered until clicked. */
export function Attachments({ server, files }: { server: ServerState; files: FileInfo[] }) {
  const [open, setOpen] = useState<number | null>(null)
  useTranslation() // sizes follow the language
  if (files.length === 0) return null
  const images = files.filter((f) => f.type.startsWith('image/'))
  const gallery = images.map((f) => ({ url: fileUrl(server.key, f), name: f.name, size: f.size, width: f.width, height: f.height }))
  return (
    <div className="attachments">
      <ImageGrid items={gallery} onOpen={setOpen} />
      {files.filter((f) => !f.type.startsWith('image/')).map((file) => {
        const url = fileUrl(server.key, file)
        const spoiler = isSpoilerName(file.name)
        if (file.type.startsWith('video/')) {
          return (
            <SpoilerCover key={file.id} active={spoiler}>
              {/* A WebM with only sound (an audio clip) gets a slim player instead of a black box. */}
              <video className="attachment-video" src={url} controls preload="metadata"
                onLoadedMetadata={(e) => e.currentTarget.classList.toggle('audio-only', e.currentTarget.videoWidth === 0)} />
            </SpoilerCover>
          )
        }
        if (file.type.startsWith('audio/')) {
          return (
            <div key={file.id} className="attachment-file">
              <span className="file-name">{shownName(file.name)}</span>
              <audio src={url} controls preload="none" />
            </div>
          )
        }
        if (isTextFile(file.name, file.size)) {
          return <SpoilerCover key={file.id} active={spoiler}><TextFilePreview url={url} name={file.name} size={file.size} /></SpoilerCover>
        }
        return (
          <a key={file.id} className="attachment-file" href={url} download={shownName(file.name)} target="_blank" rel="noopener noreferrer">
            <span className="file-icon" aria-hidden><FileIcon size={22} /></span>
            <span className="file-name">{shownName(file.name)}</span>
            <span className="muted">{formatSize(file.size)}</span>
          </a>
        )
      })}
      {open !== null && <Lightbox items={gallery} start={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

export function ReplyLine({ server, reply, onJump }: { server: ServerState; reply: ReplyPreview; onJump: (id: number) => void }) {
  const { t } = useTranslation()
  if (reply.deleted) return <div className="reply-line muted">↪ {t('chat.message.replyDeleted')}</div>
  const name = reply.importedName ?? server.members[reply.author]?.name ?? t('common.someone')
  const text = plainText(reply.text, { nameOf: (k) => server.members[k]?.name ?? null }).replace(/\s+/g, ' ')
  return (
    <button className="reply-line" onClick={() => onJump(reply.id)}>
      <span className="reply-author">↪ {name}</span>
      <span className="reply-text">{text || (reply.hasAttachments ? t('chat.message.attachment') : '')}</span>
    </button>
  )
}


export function Reactions({ server, message }: { server: ServerState; message: Message }) {
  const me = server.me?.accountKey
  const [who, setWho] = useState<string | null>(null)
  const { t } = useTranslation()
  if (message.reactions.length === 0) return null
  return (
    <div className="reactions">
      {who && <ReactionsDialog server={server} message={message} initial={who} onClose={() => setWho(null)} />}
      {message.reactions.map((r) => {
        const mine = !!me && r.accounts.includes(me)
        const names = r.accounts.map((k) => server.members[k]?.name ?? t('common.someone')).join(', ')
        return (
          <button
            key={r.emoji}
            className={`reaction ${mine ? 'mine' : ''}`}
            title={t('chat.reactions.title', { names })}
            aria-pressed={mine}
            onClick={() => toggleReaction(server.key, message, r.emoji)}
            onContextMenu={(e) => {
              e.preventDefault()
              setWho(r.emoji)
            }}
          >
            <EmojiGlyph serverKey={server.key} emoji={r.emoji} /> <span className="count">{r.accounts.length}</span>
          </button>
        )
      })}
    </div>
  )
}

export function ReactionPicker({ server, message, onClose }: { server: ServerState; message: Message; onClose: () => void }) {
  // The full picker anchors to the message's action bar, which stays while this one is replaced.
  const [full, setFull] = useState<HTMLElement | null>(null)
  const { t } = useTranslation()
  useEscapeLayer(onClose, !full)
  if (full) {
    return <EmojiPicker serverKey={server.key} anchor={full} onClose={onClose} onPick={(emoji) => toggleReaction(server.key, message, emoji)} />
  }
  return (
    <div className="reaction-picker" role="menu" onMouseLeave={onClose}>
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          role="menuitem"
          onClick={() => {
            toggleReaction(server.key, message, emoji)
            onClose()
          }}
        >
          {emoji}
        </button>
      ))}
      <button role="menuitem" aria-label={t('chat.reactions.moreEmoji')} title={t('chat.reactions.moreEmoji')}
        onClick={(e) => setFull(e.currentTarget.closest<HTMLElement>('.message-actions') ?? e.currentTarget)}>
        <SmilePlus size={18} />
      </button>
    </div>
  )
}

const previewCache = new Map<string, Promise<LinkPreview | null>>()

export function LinkPreviewCard({ server, url }: { server: ServerState; url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  useEffect(() => {
    const key = `${server.key}:${url}`
    let promise = previewCache.get(key)
    if (!promise) {
      promise = connectionFor(server.key)?.request('link.preview', { url }).then((r) => r.preview).catch(() => null) ?? Promise.resolve(null)
      previewCache.set(key, promise)
    }
    let alive = true
    void promise.then((p) => alive && setPreview(p))
    return () => {
      alive = false
    }
  }, [server.key, url])

  const embed = embedFor(url, window.location.hostname || 'localhost')
  if (embed) return <EmbedCard embed={embed} url={url} preview={preview} />
  if (!preview || (!preview.title && !preview.description)) return null
  return (
    <div className="link-preview">
      {preview.siteName && <div className="link-site">{preview.siteName}</div>}
      {preview.title && (
        <a className="link-title" href={url} target="_blank" rel="noopener noreferrer">{preview.title}</a>
      )}
      {preview.description && <div className="link-description">{preview.description}</div>}
    </div>
  )
}

/**
 * A YouTube/Twitch/X/Reddit link: the server's preview first; their player only loads when asked (it talks to them),
 * or by itself on a device that ticked "Always load from <site>" (then without autoplay).
 */
function EmbedCard({ embed, url, preview }: { embed: Embed; url: string; preview: LinkPreview | null }) {
  const [clicked, setClicked] = useState(false)
  const [remember, setRemember] = useState(false)
  const always = useAlwaysLoads(embed.site)
  const { t } = useTranslation()
  const loaded = clicked || always
  const src = clicked ? embed.src : embedFor(url, window.location.hostname || 'localhost', false)?.src ?? embed.src
  const site = siteName(embed.site)
  const action = embed.shape === 'video' ? t('chat.embed.play', { provider: embed.provider }) : t('chat.embed.load', { provider: embed.provider })
  function load() {
    if (remember) setAlwaysLoad(embed.site, true)
    setClicked(true)
  }
  return (
    <div className={`link-preview embed-card ${loaded ? 'loaded' : ''}`}>
      <div className="link-site">{preview?.siteName ?? embed.provider}</div>
      <a className="link-title" href={url} target="_blank" rel="noopener noreferrer">{preview?.title ?? url}</a>
      {preview?.description && !loaded && <div className="link-description">{preview.description}</div>}
      {loaded ? (
        <iframe
          className={`embed-frame ${embed.shape}`}
          src={src}
          title={`${embed.provider}: ${preview?.title ?? url}`}
          sandbox={EMBED_FRAME.sandbox}
          allow={EMBED_FRAME.allow}
          referrerPolicy={EMBED_FRAME.referrerPolicy}
          allowFullScreen
        />
      ) : (
        <div className="embed-gate" data-testid="embed-gate">
          <button className={`embed-play ${embed.shape}`} onClick={load}>
            <span className="embed-play-icon" aria-hidden>▶</span>
            <span>{action}</span>
            <span className="muted embed-note">{t('chat.embed.note', { provider: site })}</span>
          </button>
          <label className="checkbox embed-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('chat.embed.always', { site })}
          </label>
        </div>
      )}
    </div>
  )
}
