// The profile page editor: one HTML file on the left, a live preview on the right that runs in
// the same sandbox as the published page (public/page-preview.html).
import { useEffect, useRef, useState } from 'react'
import { MAX_PAGE_BYTES, previewDocument, STARTER_PAGE, utf8Length } from '../../core/profile'
import { publishPage, useProfiles } from '../../state/profile'
import { useApp } from '../../state/store'
import { Modal } from '../bits'

const PREVIEW_URL = `${import.meta.env.BASE_URL}page-preview.html`

export function PageEditor({ onClose }: { onClose: () => void }) {
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

  // Push the draft to the preview (debounced while typing).
  useEffect(() => {
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
  }, [html])

  async function publish(next: string | null) {
    setBusy(true)
    try {
      const failed = await publishPage(next)
      setStatus(
        failed.length
          ? { kind: 'error', text: `Saved here, but ${failed.join(', ')} didn't take it.` }
          : { kind: 'saved', text: next === null ? 'Page removed' : 'Published' },
      )
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Your profile page"
      onClose={onClose}
      wide
      footer={
        <>
          {status && <span className={`editor-status ${status.kind === 'error' ? 'error-text' : 'success-text'}`}>{status.text}</span>}
          {saved && <button className="button danger-outline" disabled={busy} onClick={() => void publish(null)}>Unpublish</button>}
          <button className="button primary" disabled={busy || tooBig || !html.trim()} onClick={() => void publish(html)}>Publish</button>
        </>
      }
    >
      <p className="muted page-note">
        One HTML file with inline CSS, JavaScript and data: images, up to {MAX_PAGE_BYTES / 1024} KB. It runs in a sandbox:
        no network, no forms, no pop-ups, and no access to anyone's account.
        {closedOn.length > 0 && ` Pages are turned off on ${closedOn.join(', ')}.`}
      </p>
      <div className="page-editor">
        <div className="page-source">
          <textarea
            value={html}
            spellCheck={false}
            aria-label="Page HTML"
            onChange={(e) => { setHtml(e.target.value); setStatus(null) }}
          />
          <div className="page-source-bar">
            <span className={tooBig ? 'error-text' : 'muted'}>{(bytes / 1024).toFixed(1)} / {MAX_PAGE_BYTES / 1024} KB</span>
            <button className="link" onClick={() => setHtml(STARTER_PAGE)}>Start from the template</button>
          </div>
        </div>
        <iframe
          ref={frame}
          className="page-preview"
          title="Preview"
          src={PREVIEW_URL}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; autoplay 'none'"
        />
      </div>
    </Modal>
  )
}
