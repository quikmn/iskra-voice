// A new post in a media channel: pictures and videos (picked or dropped, previewed), an optional title, a caption,
// tags and "sensitive". Files upload when you post, so marking them sensitive (SPOILER_) can still change until then.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { Channel, ForumTag } from '../../core/protocol'
import { uploadFile, type ServerState } from '../../state/store'
import { createPost, openPost } from '../../state/forums'
import { useServerEmojis } from '../../state/expressions'
import { encodeEmoji } from '../expressions/emoji'
import { encodeMentions } from '../markdown'
import { Modal } from '../bits'
import { Close, Plus } from '../icons'
import { MAX_POST_TAGS } from '../forums/ForumDialogs'
import { MAX_MEDIA, isMediaFile, uploadName } from './gallery'
import { PlayIcon } from './icons'

interface Picked {
  key: string
  file: File
  url: string
}

let counter = 0

export function NewMediaPostDialog({ server, channel, tags, onClose }: { server: ServerState; channel: Channel; tags: ForumTag[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<Picked[]>([])
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [chosenTags, setChosenTags] = useState<number[]>([])
  const [sensitive, setSensitive] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const abort = useRef<AbortController | null>(null)
  const emojis = useServerEmojis(server.key)
  const busy = progress !== null
  const canPost = picked.length > 0 && !busy

  // Previews are object URLs: let them go with the dialog.
  const urls = useMemo(() => new Set<string>(), [])
  useEffect(() => () => {
    abort.current?.abort()
    for (const url of urls) URL.revokeObjectURL(url)
  }, [urls])

  function add(files: FileList | File[] | null) {
    setNotice(null)
    const list = [...(files ?? [])]
    const refused = list.find((f) => !isMediaFile(f))
    const media = list.filter(isMediaFile)
    setPicked((current) => {
      const room = MAX_MEDIA - current.length
      if (media.length > room) setNotice(t('mediaChannels.newPost.tooMany', { max: MAX_MEDIA }))
      return [...current, ...media.slice(0, Math.max(0, room)).map((file) => {
        const url = URL.createObjectURL(file)
        urls.add(url)
        return { key: `m${++counter}`, file, url }
      })]
    })
    if (refused) setNotice(t('mediaChannels.newPost.onlyMedia', { name: refused.name }))
  }

  async function post() {
    if (!canPost) return
    setError(null)
    setProgress(0)
    const controller = new AbortController()
    abort.current = controller
    try {
      const total = picked.reduce((n, p) => n + p.file.size, 0) || 1
      let done = 0
      const ids: string[] = []
      for (const p of picked) {
        const named = new File([p.file], uploadName(p.file.name, sensitive), { type: p.file.type })
        const info = await uploadFile(server.key, named, (f) => setProgress((done + f * p.file.size) / total), controller.signal)
        done += p.file.size
        ids.push(info.id)
      }
      setProgress(1)
      const body = encodeEmoji(encodeMentions(text.trim(), Object.values(server.members)), emojis)
      const created = await createPost(server.key, channel.id, title.trim(), body, chosenTags, ids)
      openPost(server.key, created)
      onClose()
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError(errorMessage(e))
      setProgress(null)
    }
  }

  return (
    <Modal
      title={t('mediaChannels.newPost.title')}
      heading={<Trans i18nKey="mediaChannels.newPost.heading" values={{ channel: channel.name }} tOptions={{ interpolation: { escapeValue: true } }} shouldUnescape components={{ name: <span className="muted" /> }} />}
      onClose={onClose}
      wide
      className="post-modal media-post-modal"
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!canPost} onClick={() => void post()} data-testid="media-post-submit">
            {progress === null ? t('mediaChannels.newPost.post')
              : progress < 1 ? t('mediaChannels.newPost.uploading', { percent: Math.round(progress * 100) }) : t('mediaChannels.newPost.posting')}
          </button>
        </>
      }
    >
      <div
        className={`media-drop ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (!busy) add(e.dataTransfer.files)
        }}
      >
        {picked.length > 0 && (
          <ul className="media-picked">
            {picked.map((p) => (
              <li key={p.key}>
                {p.file.type.startsWith('video/')
                  ? <><video src={p.url} muted playsInline preload="metadata" className={sensitive ? 'sensitive' : ''} /><span className="media-badge"><PlayIcon size={12} /></span></>
                  : <img src={p.url} alt={p.file.name} className={sensitive ? 'sensitive' : ''} />}
                <button type="button" className="icon-button small" disabled={busy} aria-label={t('mediaChannels.newPost.remove', { name: p.file.name })}
                  onClick={() => setPicked((list) => list.filter((x) => x.key !== p.key))}>
                  <Close size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {picked.length < MAX_MEDIA && (
          <p className="media-drop-hint">
            {t('mediaChannels.newPost.drop')}{' '}
            <button type="button" className="button small" disabled={busy} onClick={() => input.current?.click()} data-autofocus>
              <Plus size={14} /> {picked.length === 0 ? t('mediaChannels.newPost.add') : t('mediaChannels.newPost.choose')}
            </button>
          </p>
        )}
        <p className="muted small-text">{t('mediaChannels.newPost.limit', { max: MAX_MEDIA })}</p>
        <input ref={input} type="file" accept="image/*,video/*" multiple hidden data-testid="media-file-input"
          onChange={(e) => {
            add(e.target.files)
            e.target.value = ''
          }} />
      </div>
      {notice && <p className="muted small-text" role="status">{notice}</p>}
      <label className="checkbox">
        <input type="checkbox" checked={sensitive} disabled={busy} onChange={(e) => setSensitive(e.target.checked)} />
        {t('mediaChannels.newPost.sensitive')}
      </label>
      <label className="field">
        <span>{t('mediaChannels.newPost.titleLabel')} <span className="muted">{t('mediaChannels.newPost.optional')}</span></span>
        <input value={title} maxLength={100} disabled={busy} onChange={(e) => setTitle(e.target.value)} placeholder={t('mediaChannels.newPost.titlePlaceholder')} />
      </label>
      <label className="field">
        <span>{t('mediaChannels.newPost.caption')} <span className="muted">{t('mediaChannels.newPost.optional')}</span></span>
        <textarea
          value={text}
          maxLength={4000}
          rows={3}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void post()
          }}
          placeholder={t('mediaChannels.newPost.captionPlaceholder')}
        />
      </label>
      {tags.length > 0 && (
        <fieldset className="field tag-picker">
          <legend>{t('mediaChannels.newPost.tags')} <span className="muted">{t('mediaChannels.newPost.upTo', { max: MAX_POST_TAGS })}</span></legend>
          <div className="forum-tags inline">
            {tags.map((tag) => {
              const on = chosenTags.includes(tag.id)
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`tag-chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  disabled={busy || (!on && chosenTags.length >= MAX_POST_TAGS)}
                  onClick={() => setChosenTags((list) => (on ? list.filter((id) => id !== tag.id) : [...list, tag.id]))}
                >
                  {tag.emoji && <span aria-hidden>{tag.emoji}</span>}
                  {tag.name}
                </button>
              )
            })}
          </div>
        </fieldset>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
