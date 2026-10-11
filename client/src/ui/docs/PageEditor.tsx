// Writing a page: title, a toolbar, the Markdown on the left and a live preview on the right (on phones, a toggle
// between the two). Saving names the version the edit started from; if someone saved first, ConflictDialog decides.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, DocPage } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { uploadFile } from '../../state/store'
import { loadPage, MAX_PAGE_BYTES, MAX_TITLE_LENGTH, openPage, saveDraft, setDraft, updateDraft, type DocDraft } from '../../state/docs'
import { hasConflictMarkers, imageMarkdown, TABLE_TEMPLATE } from '../../state/docsLogic'
import { errorMessage } from '../../i18n/errors'
import { formatBytes } from '../../i18n/format'
import { RequestError } from '../../core/protocol'
import { insertBlock, link, prefixLines, wrap, type Edit } from './editing'
import { renderDoc } from './docMarkdown'
import { useDocContext } from './hooks'
import { CodeIcon, ImageIcon, LinkIcon, ListIcon, PageIcon, QuoteIcon, TableIcon } from './icons'
import { ConflictDialog, LinkPicker, type ConflictChoice } from './DocDialogs'

const bytes = (text: string) => new TextEncoder().encode(text).length

export function PageEditor({ server, channel, draft, pages }: { server: ServerState; channel: Channel; draft: DocDraft; pages: DocPage[] }) {
  const { t } = useTranslation()
  const ctx = useDocContext(server)
  const area = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [view, setView] = useState<'write' | 'preview'>('write')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<DocPage | null>(null)
  const [picking, setPicking] = useState(false)
  const [preview, setPreview] = useState(draft.text)
  const size = bytes(draft.text)
  const over = size > MAX_PAGE_BYTES
  const parent = draft.parentId !== null ? pages.find((p) => p.id === draft.parentId) : undefined
  const isNew = draft.pageId === null

  // The preview follows typing with a short delay, so long pages stay smooth.
  useEffect(() => {
    const timer = setTimeout(() => setPreview(draft.text), draft.text.length > 20_000 ? 400 : 120)
    return () => clearTimeout(timer)
  }, [draft.text])
  const rendered = useMemo(() => renderDoc(preview, ctx), [preview, ctx.serverUrl, server.members]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p: Partial<DocDraft>) => updateDraft(server.key, channel.id, p)

  /** Applies a toolbar edit to the text and puts the selection where it belongs. */
  function apply(make: (text: string, start: number, end: number) => Edit) {
    const el = area.current
    const start = el?.selectionStart ?? draft.text.length
    const end = el?.selectionEnd ?? draft.text.length
    const edit = make(draft.text, start, end)
    patch({ text: edit.text })
    setView('write')
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(edit.start, edit.end)
    })
  }

  async function addPicture(files: FileList | null) {
    const picked = files?.[0]
    if (!picked) return
    setUploading(true)
    setError(null)
    try {
      const uploaded = await uploadFile(server.key, picked, () => undefined)
      if (!uploaded.type.startsWith('image/')) throw new Error(t('docs.editor.notPicture'))
      apply((text, start) => insertBlock(text, start, imageMarkdown(uploaded.name, uploaded.url)))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setUploading(false)
      if (file.current) file.current.value = ''
    }
  }

  async function save(current: DocDraft = draft) {
    if (busy) return
    if (!current.title.trim()) return setError(t('docs.editor.needTitle'))
    if (bytes(current.text) > MAX_PAGE_BYTES) return setError(t('docs.editor.tooBig'))
    if (hasConflictMarkers(current.text)) return setError(t('docs.editor.markersLeft'))
    setBusy(true)
    setError(null)
    try {
      await saveDraft(server.key, current)
    } catch (e) {
      if (e instanceof RequestError && e.code === 'conflict' && current.pageId !== null) {
        try {
          setConflict(await loadPage(server.key, current.pageId, true))
        } catch (inner) {
          setError(errorMessage(inner))
        }
      } else setError(errorMessage(e))
      setBusy(false)
    }
  }

  function cancel() {
    setDraft(server.key, channel.id, null)
    if (isNew) openPage(server.key, channel.id, draft.parentId)
  }

  function resolve(choice: ConflictChoice, latest: DocPage) {
    setConflict(null)
    const rebased = { baseVersion: latest.version, baseText: latest.text ?? '', baseTitle: latest.title }
    if (choice.kind === 'theirs') {
      setDraft(server.key, channel.id, null)
      return
    }
    // A title only they changed follows theirs; one I changed stays mine.
    const title = draft.title === draft.baseTitle ? latest.title : draft.title
    if (choice.kind === 'mine') {
      const next = { ...draft, ...rebased, title }
      setDraft(server.key, channel.id, next)
      void save(next)
      return
    }
    patch({ ...rebased, title, text: choice.text, note: choice.conflicts ? 'markers' : 'merged' })
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    } else if (mod && e.key.toLowerCase() === 'b' && e.currentTarget === area.current) {
      e.preventDefault()
      apply((x, s, en) => wrap(x, s, en, '**', '**', t('docs.editor.boldText')))
    } else if (mod && e.key.toLowerCase() === 'i' && e.currentTarget === area.current) {
      e.preventDefault()
      apply((x, s, en) => wrap(x, s, en, '*', '*', t('docs.editor.italicText')))
    } else if (e.key === 'Escape' && !busy && draft.text === draft.baseText && draft.title === draft.baseTitle) {
      cancel()
    }
  }

  const tools: { label: string; icon: ReactNode; run: () => void }[] = [
    { label: t('docs.editor.bold'), icon: <strong>B</strong>, run: () => apply((x, s, e) => wrap(x, s, e, '**', '**', t('docs.editor.boldText'))) },
    { label: t('docs.editor.italic'), icon: <em>I</em>, run: () => apply((x, s, e) => wrap(x, s, e, '*', '*', t('docs.editor.italicText'))) },
    { label: t('docs.editor.heading'), icon: <span className="docs-tool-h">H</span>, run: () => apply((x, s, e) => prefixLines(x, s, e, '## ')) },
    { label: t('docs.editor.list'), icon: <ListIcon size={16} />, run: () => apply((x, s, e) => prefixLines(x, s, e, '- ')) },
    { label: t('docs.editor.numbered'), icon: <span className="docs-tool-h">1.</span>, run: () => apply((x, s, e) => prefixLines(x, s, e, '1. ')) },
    { label: t('docs.editor.quote'), icon: <QuoteIcon size={15} />, run: () => apply((x, s, e) => prefixLines(x, s, e, '> ')) },
    { label: t('docs.editor.code'), icon: <CodeIcon size={16} />, run: () => apply((x, s, e) => (x.slice(s, e).includes('\n') ? wrap(x, s, e, '```\n', '\n```') : wrap(x, s, e, '`', '`', t('docs.editor.codeText')))) },
    { label: t('docs.editor.table'), icon: <TableIcon size={16} />, run: () => apply((x, s) => insertBlock(x, s, TABLE_TEMPLATE)) },
    { label: t('docs.editor.link'), icon: <LinkIcon size={16} />, run: () => setPicking(true) },
    { label: t('docs.editor.picture'), icon: <ImageIcon size={16} />, run: () => file.current?.click() },
  ]

  return (
    <div className={`docs-editor show-${view}`}>
      <p className="docs-editor-where muted">
        <PageIcon size={14} />{' '}
        {isNew ? (parent ? t('docs.editor.newSubPage', { parent: parent.title }) : t('docs.editor.newPage')) : t('docs.editor.editing')}
      </p>
      {draft.note && (
        <div className="docs-merge-note" role="status">
          <span>{draft.note === 'markers' ? t('docs.editor.markersNote') : t('docs.editor.mergedNote')}</span>
          <button className="docs-linkish" onClick={() => patch({ note: null })}>{t('common.close')}</button>
        </div>
      )}
      <input
        className="docs-title-input"
        value={draft.title}
        maxLength={MAX_TITLE_LENGTH}
        placeholder={t('docs.editor.titlePlaceholder')}
        aria-label={t('docs.editor.title')}
        autoFocus={isNew}
        onChange={(e) => patch({ title: e.target.value })}
        onKeyDown={onKeyDown}
      />
      <div className="docs-toolbar" role="toolbar" aria-label={t('docs.editor.formatting')}>
        {tools.map((tool) => (
          <button key={tool.label} type="button" className="icon-button docs-tool" onClick={tool.run} aria-label={tool.label} title={tool.label}
            disabled={tool.label === t('docs.editor.picture') && uploading}>
            {tool.icon}
          </button>
        ))}
        <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => void addPicture(e.target.files)} />
        <span className="spacer" />
        <div className="segmented small docs-view-toggle" role="radiogroup" aria-label={t('docs.editor.view')}>
          <button role="radio" aria-checked={view === 'write'} className={view === 'write' ? 'on' : ''} onClick={() => setView('write')}>{t('docs.editor.write')}</button>
          <button role="radio" aria-checked={view === 'preview'} className={view === 'preview' ? 'on' : ''} onClick={() => setView('preview')}>{t('docs.editor.preview')}</button>
        </div>
      </div>
      <div className="docs-panes">
        <textarea
          ref={area}
          className="docs-textarea"
          value={draft.text}
          aria-label={t('docs.editor.text')}
          placeholder={t('docs.editor.textPlaceholder')}
          spellCheck
          onChange={(e) => patch({ text: e.target.value })}
          onKeyDown={onKeyDown}
          autoFocus={!isNew}
        />
        <div className="docs-preview" aria-label={t('docs.editor.preview')}>
          {preview.trim() ? <div className="docs-content">{rendered}</div> : <p className="muted">{t('docs.editor.previewEmpty')}</p>}
        </div>
      </div>
      <footer className="docs-editor-foot">
        <span className={`docs-size ${over ? 'over' : ''}`}>{t('docs.editor.size', { size: formatBytes(size), max: formatBytes(MAX_PAGE_BYTES) })}</span>
        {uploading && <span className="muted">{t('docs.editor.uploading')}</span>}
        {error && <span className="error-text" role="alert">{error}</span>}
        <span className="spacer" />
        <button className="button" onClick={cancel} disabled={busy}>{t('common.cancel')}</button>
        <button className="button primary" onClick={() => void save()} disabled={busy || over || !draft.title.trim()}>
          {busy ? t('docs.editor.saving') : isNew ? t('docs.editor.create') : t('docs.editor.save')}
        </button>
      </footer>
      {conflict && (
        <ConflictDialog server={server} draft={draft} latest={conflict} onChoose={(c) => resolve(c, conflict)} onClose={() => setConflict(null)} />
      )}
      {picking && (
        <LinkPicker server={server} onClose={() => setPicking(false)} onPick={(url, label) => {
          setPicking(false)
          apply((x, s, e) => link(x, s, e, url, label))
        }} />
      )}
    </div>
  )
}
