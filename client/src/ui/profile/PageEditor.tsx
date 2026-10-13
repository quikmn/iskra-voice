// The profile page editor: one HTML file on the left, a live preview on the right that runs in
// the same sandbox as the published page (public/page-preview.html; in the desktop app, its page wall).
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { formatNumber } from '../../i18n/format'
import { MAX_PAGE_BYTES, previewDocument, previewSource, STARTER_PAGE, utf8Length } from '../../core/profile'
import { publishPage, useProfiles } from '../../state/profile'
import { useApp } from '../../state/store'
import { Modal } from '../bits'
import { PageWebview, pageWall } from './PageView'

const PREVIEW_URL = `${import.meta.env.BASE_URL}page-preview.html`

export function PageEditor({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const saved = useApp((s) => s.profile?.page ?? null)
  const [html, setHtml] = useState(saved?.html ?? STARTER_PAGE)
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const bytes = utf8Length(html)
  const tooBig = bytes > MAX_PAGE_BYTES
  const servers = useApp((s) => s.servers)
  const pagesEnabled = useProfiles((s) => s.pagesEnabled)
  const closedOn = Object.values(servers).filter((s) => s.me && pagesEnabled[s.key] === false).map((s) => s.name)
  const wall = pageWall()
  const [draft, setDraft] = useState(html) // what the desktop preview shows, a moment behind the typing

  useEffect(() => {
    if (!wall) return
    const timer = setTimeout(() => setDraft(html), 250)
    return () => clearTimeout(timer)
  }, [html, wall])

  // Push the draft to the preview (debounced while typing).
  useEffect(() => {
    if (wall) return
    const send = () => frame.current?.contentWindow?.postMessage({ type: 'iskra:preview', html: previewDocument(html, null) }, '*')
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && (e.data as { type?: string })?.type === 'iskra:preview-ready') {
        ready.current = true
        send()
      }
    }
    window.addEventListener('message', onMessage)
    const timer = ready.current ? setTimeout(send, 250) : undefined
    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
    }
  }, [html, wall])

  async function publish(next: string | null) {
    setBusy(true)
    try {
      const failed = await publishPage(next)
      setStatus(
        failed.length
          ? { kind: 'error', text: t('profile.savedExcept', { servers: failed.join(', ') }) }
          : { kind: 'saved', text: next === null ? t('profile.pageRemoved') : t('profile.published') },
      )
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('profile.yourPage')}
      onClose={onClose}
      wide
      footer={
        <>
          {status && <span className={`editor-status ${status.kind === 'error' ? 'error-text' : 'success-text'}`}>{status.text}</span>}
          {saved && <button className="button danger-outline" disabled={busy} onClick={() => void publish(null)}>{t('profile.unpublish')}</button>}
          <button className="button primary" disabled={busy || tooBig || !html.trim()} onClick={() => void publish(html)}>{t('profile.publish')}</button>
        </>
      }
    >
      <p className="muted page-note">
        {t('profile.editorNote', { max: MAX_PAGE_BYTES / 1024 })}
        {closedOn.length > 0 && ` ${t('profile.pagesOff', { servers: closedOn.join(', ') })}`}
      </p>
      <div className="page-editor">
        <div className="page-source">
          <textarea
            value={html}
            spellCheck={false}
            aria-label={t('profile.pageHtml')}
            onChange={(e) => { setHtml(e.target.value); setStatus(null) }}
          />
          <div className="page-source-bar">
            <span className={tooBig ? 'error-text' : 'muted'}>{formatNumber(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / {MAX_PAGE_BYTES / 1024} KB</span>
            <button className="link" onClick={() => setHtml(STARTER_PAGE)}>{t('profile.template')}</button>
          </div>
        </div>
        {wall ? (
          <PageWebview className="page-preview" src={previewSource(draft)} title={t('profile.preview')} />
        ) : (
          <iframe
            ref={frame}
            className="page-preview"
            title={t('profile.preview')}
            src={PREVIEW_URL}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; autoplay 'none'"
          />
        )}
      </div>
      {/* The preview has no server to load them from (it runs walled off, like the page itself). */}
      {html.includes('/files/') && <p className="muted small-text page-preview-note" role="note">{t('profile.previewFiles')}</p>}
    </Modal>
  )
}
