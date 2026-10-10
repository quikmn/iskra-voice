// Everything around a message's text: attachments, the message it replies to, reactions.
import { useState } from 'react'
import type { FileInfo, Message, ReplyPreview } from '../../core/protocol'
import { formatSize, QUICK_REACTIONS } from './helpers'
import { fileUrl, toggleReaction, type ServerState } from '../../state/store'
import { Modal } from '../bits'

const MAX_W = 420
const MAX_H = 320

/** Fits an image into the preview box while keeping its shape, so nothing jumps when it loads. */
function previewSize(file: FileInfo): { width: number; height: number } | undefined {
  if (!file.width || !file.height) return undefined
  const scale = Math.min(1, MAX_W / file.width, MAX_H / file.height)
  return { width: Math.round(file.width * scale), height: Math.round(file.height * scale) }
}

export function Attachments({ server, files }: { server: ServerState; files: FileInfo[] }) {
  const [open, setOpen] = useState<FileInfo | null>(null)
  if (files.length === 0) return null
  return (
    <div className="attachments">
      {files.map((file) => {
        const url = fileUrl(server.key, file)
        if (file.type.startsWith('image/')) {
          return (
            <button key={file.id} className="attachment-image" onClick={() => setOpen(file)} aria-label={`Open ${file.name}`}>
              <img src={url} alt={file.name} loading="lazy" style={previewSize(file)} />
            </button>
          )
        }
        if (file.type.startsWith('video/')) {
          return <video key={file.id} className="attachment-video" src={url} controls preload="metadata" />
        }
        if (file.type.startsWith('audio/')) {
          return (
            <div key={file.id} className="attachment-file">
              <span className="file-name">{file.name}</span>
              <audio src={url} controls preload="none" />
            </div>
          )
        }
        return (
          <a key={file.id} className="attachment-file" href={url} download={file.name} target="_blank" rel="noopener noreferrer">
            <span className="file-icon" aria-hidden>📄</span>
            <span className="file-name">{file.name}</span>
            <span className="muted">{formatSize(file.size)}</span>
          </a>
        )
      })}
      {open && (
        <Modal title={open.name} onClose={() => setOpen(null)}>
          <img className="lightbox-image" src={fileUrl(server.key, open)} alt={open.name} />
          <p className="muted">
            <a href={fileUrl(server.key, open)} target="_blank" rel="noopener noreferrer">Open original</a> · {formatSize(open.size)}
          </p>
        </Modal>
      )}
    </div>
  )
}

export function ReplyLine({ server, reply, onJump }: { server: ServerState; reply: ReplyPreview; onJump: (id: number) => void }) {
  if (reply.deleted) return <div className="reply-line muted">↪ Original message was deleted</div>
  const name = server.members[reply.author]?.name ?? 'Someone'
  return (
    <button className="reply-line" onClick={() => onJump(reply.id)}>
      <span className="reply-author">↪ {name}</span>
      <span className="reply-text">{reply.text || (reply.hasAttachments ? 'Attachment' : '')}</span>
    </button>
  )
}


export function Reactions({ server, message }: { server: ServerState; message: Message }) {
  const me = server.me?.accountKey
  if (message.reactions.length === 0) return null
  return (
    <div className="reactions">
      {message.reactions.map((r) => {
        const mine = !!me && r.accounts.includes(me)
        const names = r.accounts.map((k) => server.members[k]?.name ?? 'Someone').join(', ')
        return (
          <button
            key={r.emoji}
            className={`reaction ${mine ? 'mine' : ''}`}
            title={names}
            aria-pressed={mine}
            onClick={() => toggleReaction(server.key, message, r.emoji)}
          >
            <span>{r.emoji}</span> <span className="count">{r.accounts.length}</span>
          </button>
        )
      })}
    </div>
  )
}

export function ReactionPicker({ server, message, onClose }: { server: ServerState; message: Message; onClose: () => void }) {
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
    </div>
  )
}
