// Forum dialogs: writing a new post, and the admin's tag editor.
import { useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { Channel, FileInfo, ForumTag } from '../../core/protocol'
import { uploadFile, type ServerState } from '../../state/store'
import { createPost, openPost, saveTags } from '../../state/forums'
import { useServerEmojis } from '../../state/expressions'
import { encodeEmoji } from '../expressions/emoji'
import { encodeMentions } from '../markdown'
import { formatSize } from '../chat/helpers'
import { Modal } from '../bits'
import { Close, Paperclip, Plus, Trash } from '../icons'

export const MAX_POST_TAGS = 5
export const MAX_FORUM_TAGS = 20

let counter = 0
const nextKey = () => `k${++counter}`

interface Upload {
  id: string
  name: string
  size: number
  progress: number
  result?: FileInfo
  error?: string
  abort: AbortController
}

export function NewPostDialog({ server, forum, tags, onClose }: { server: ServerState; forum: Channel; tags: ForumTag[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [uploads, setUploads] = useState<Upload[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const emojis = useServerEmojis(server.key)
  const uploading = uploads.some((u) => !u.result && !u.error)
  const ready = uploads.filter((u) => u.result).map((u) => u.result!)
  const canPost = title.trim().length > 0 && (text.trim().length > 0 || ready.length > 0) && !uploading && !busy

  function attach(files: FileList | null) {
    for (const file of files ?? []) {
      const item: Upload = { id: nextKey(), name: file.name, size: file.size, progress: 0, abort: new AbortController() }
      const update = (patch: Partial<Upload>) => setUploads((list) => list.map((u) => (u.id === item.id ? { ...u, ...patch } : u)))
      setUploads((list) => [...list, item].slice(0, 10))
      uploadFile(server.key, file, (progress) => update({ progress }), item.abort.signal)
        .then((result) => update({ result, progress: 1 }))
        .catch((e: Error) => update({ error: e.name === 'AbortError' ? undefined : errorMessage(e) }))
    }
  }

  async function post() {
    if (!canPost) return
    setBusy(true)
    setError(null)
    try {
      const body = encodeEmoji(encodeMentions(text.trim(), Object.values(server.members)), emojis)
      const created = await createPost(server.key, forum.id, title.trim(), body, picked, ready.map((f) => f.id))
      openPost(server.key, created)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('forums.newPost.title')}
      heading={<Trans i18nKey="forums.newPost.heading" values={{ forum: forum.name }} tOptions={{ interpolation: { escapeValue: true } }} shouldUnescape components={{ name: <span className="muted" /> }} />}
      onClose={onClose}
      wide
      className="post-modal"
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!canPost} onClick={() => void post()}>{busy ? t('forums.newPost.posting') : t('forums.newPost.post')}</button>
        </>
      }
    >
      <label className="field">
        <span>{t('forums.newPost.titleLabel')}</span>
        <input value={title} maxLength={100} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder={t('forums.newPost.titlePlaceholder')} />
      </label>
      <label className="field">
        <span>{t('forums.newPost.message')}</span>
        <textarea
          value={text}
          maxLength={4000}
          rows={6}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void post()
          }}
          placeholder={t('forums.newPost.messagePlaceholder')}
        />
      </label>
      {tags.length > 0 && (
        <fieldset className="field tag-picker">
          <legend>{t('forums.newPost.tags')} <span className="muted">{t('forums.newPost.upTo', { max: MAX_POST_TAGS })}</span></legend>
          <div className="forum-tags inline">
            {tags.map((tag) => {
              const on = picked.includes(tag.id)
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`tag-chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  disabled={!on && picked.length >= MAX_POST_TAGS}
                  onClick={() => setPicked((p) => (on ? p.filter((id) => id !== tag.id) : [...p, tag.id]))}
                >
                  {tag.emoji && <span aria-hidden>{tag.emoji}</span>}
                  {tag.name}
                </button>
              )
            })}
          </div>
        </fieldset>
      )}
      <div className="post-attachments">
        <button type="button" className="button small" onClick={() => fileInput.current?.click()} disabled={uploads.length >= 10}>
          <Paperclip size={14} /> {t('forums.newPost.attach')}
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { attach(e.target.files); e.target.value = '' }} />
        {uploads.map((u) => (
          <span key={u.id} className={`upload-chip ${u.error ? 'failed' : ''}`}>
            <span className="upload-name">{u.name}</span>
            <span className="muted">{u.error ?? (u.result ? formatSize(u.size) : `${Math.round(u.progress * 100)}%`)}</span>
            <button
              type="button"
              className="icon-button small"
              aria-label={t('forums.newPost.remove', { name: u.name })}
              onClick={() => {
                u.abort.abort()
                setUploads((list) => list.filter((x) => x.id !== u.id))
              }}
            >
              <Close size={12} />
            </button>
          </span>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

interface DraftTag {
  key: string
  id?: number
  name: string
  emoji: string
}

export function TagsDialog({ server, forum, tags, onClose }: { server: ServerState; forum: Channel; tags: ForumTag[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<DraftTag[]>(() => tags.map((tag) => ({ key: `t${tag.id}`, id: tag.id, name: tag.name, emoji: tag.emoji ?? '' })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names = draft.map((tag) => tag.name.trim().toLowerCase())
  const problem = names.some((n) => !n) ? t('forums.tags.problemName')
    : new Set(names).size !== names.length ? t('forums.tags.problemUnique') : null

  const patch = (key: string, change: Partial<DraftTag>) => setDraft((list) => list.map((tag) => (tag.key === key ? { ...tag, ...change } : tag)))

  async function save() {
    if (problem || busy) return
    setBusy(true)
    try {
      await saveTags(server.key, forum.id, draft.map((tag) => ({ id: tag.id, name: tag.name.trim(), emoji: tag.emoji.trim() || null })))
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('forums.tags.title')}
      heading={<Trans i18nKey="forums.tags.heading" values={{ forum: forum.name }} tOptions={{ interpolation: { escapeValue: true } }} shouldUnescape components={{ name: <span className="muted" /> }} />}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!!problem || busy} onClick={() => void save()}>{t('common.save')}</button>
        </>
      }
    >
      <p className="muted">{t('forums.tags.intro', { max: MAX_POST_TAGS })}</p>
      <ul className="tag-editor">
        {draft.map((tag) => (
          <li key={tag.key}>
            <input className="tag-emoji" value={tag.emoji} maxLength={16} placeholder="🙂" aria-label={t('forums.tags.emoji')} onChange={(e) => patch(tag.key, { emoji: e.target.value })} />
            <input value={tag.name} maxLength={20} placeholder={t('forums.tags.namePlaceholder')} aria-label={t('forums.tags.nameLabel')} onChange={(e) => patch(tag.key, { name: e.target.value })} />
            <button className="icon-button" aria-label={tag.name ? t('forums.tags.remove', { name: tag.name }) : t('forums.tags.removeTag')} onClick={() => setDraft((list) => list.filter((x) => x.key !== tag.key))}>
              <Trash size={16} />
            </button>
          </li>
        ))}
      </ul>
      {draft.length < MAX_FORUM_TAGS ? (
        <button className="button small" onClick={() => setDraft((list) => [...list, { key: nextKey(), name: '', emoji: '' }])}>
          <Plus size={14} /> {t('forums.tags.add')}
        </button>
      ) : (
        <p className="muted">{t('forums.tags.max', { max: MAX_FORUM_TAGS })}</p>
      )}
      {(problem && draft.length > 0 ? problem : error) && <p className="error-text">{error ?? problem}</p>}
    </Modal>
  )
}
