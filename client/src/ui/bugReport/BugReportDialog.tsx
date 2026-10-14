// "Report a bug" (Help → Report a bug, the status menu, Ctrl+Shift+B): what happened, steps, what you expected,
// screenshots (paste, drop, pick, or a picture of the Iskra window on desktop), logs on by default with a view of
// exactly what's sent, an optional email. Sent to Iskra's bug inbox; if that fails, saved as a zip to email instead.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop } from '../../platform/desktop'
import { native } from '../../platform/native'
import { SAFETY_EMAIL } from '../../state/terms'
import { closeBugReport, openBugReport, preparePayload, resetDraft, updateDraft, useBugReport } from '../../state/bugReport/bugReport'
import { prepareImage } from '../../state/bugReport/images'
import { canSend, MAX_EMAIL, MAX_EXPECTED, MAX_IMAGES, MAX_STEPS, MAX_WHAT, previewPayload, reportFiles, validEmail, type ReportPayload } from '../../state/bugReport/payload'
import { BugSendError, sendBugReport, type SendFailure } from '../../state/bugReport/send'
import { makeZip } from '../../state/bugReport/zip'
import { Modal, Spinner } from '../bits'
import { Close } from '../icons'
import './bugReport.css'

/** Mounted once: the dialog when open, and Ctrl+Shift+B (Cmd+Shift+B on a Mac) to open it. */
export function BugReportLayer() {
  const open = useBugReport((s) => s.open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyB') {
        e.preventDefault()
        openBugReport()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return open ? <BugReportDialog /> : null
}

type Phase = { kind: 'form' } | { kind: 'sending' } | { kind: 'sent'; id: string } | { kind: 'failed'; reason: SendFailure }

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

async function saveZip(payload: ReportPayload): Promise<string> {
  const name = `iskra-bug-report-${stamp()}.zip`
  const blob = new Blob([makeZip(reportFiles(payload)) as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
  if (native) {
    await native.saveFile(blob, name)
    return name
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return name
}

function BugReportDialog() {
  const { t } = useTranslation()
  const draft = useBugReport((s) => s.draft)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [preview, setPreview] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [adding, setAdding] = useState(0)
  const [capturing, setCapturing] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [emailTouched, setEmailTouched] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const room = MAX_IMAGES - draft.images.length - adding
  const emailBad = emailTouched && draft.email.trim() !== '' && !validEmail(draft.email)
  const ready = canSend(draft) && adding === 0 && phase.kind !== 'sending'

  // The preview follows the form while it's open, so it always shows what Send would send.
  const previewOpen = preview !== null
  useEffect(() => {
    if (!previewOpen) return
    let live = true
    void preparePayload(draft).then((payload) => live && setPreview(previewPayload(payload)))
    return () => { live = false }
  }, [draft, previewOpen])

  async function addBlobs(blobs: Blob[]) {
    setImageError(null)
    const images = blobs.filter((b) => b.type.startsWith('image/'))
    if (images.length < blobs.length) setImageError(t('bugReport.notImage'))
    const take = images.slice(0, Math.max(0, room))
    if (images.length > take.length) setImageError(t('bugReport.tooMany', { max: MAX_IMAGES }))
    if (!take.length) return
    setAdding((n) => n + take.length)
    for (const blob of take) {
      try {
        const image = await prepareImage(blob)
        const current = useBugReport.getState().draft.images
        if (current.length < MAX_IMAGES) updateDraft({ images: [...current, image] })
      } catch (e) {
        setImageError((e as Error).message === 'Image too big' ? t('bugReport.imageTooBig') : t('bugReport.notImage'))
      } finally {
        setAdding((n) => n - 1)
      }
    }
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
    if (!files.length) return
    e.preventDefault()
    void addBlobs(files)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    void addBlobs([...e.dataTransfer.files])
  }

  async function screenshot() {
    if (!desktop?.captureApp || room <= 0) return
    // The dialog steps aside so the picture shows the app, not this form.
    setCapturing(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const url = await desktop.captureApp()
      const data = url?.startsWith('data:image/png;base64,') ? url.slice(22) : null
      if (data) await addBlobs([new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'image/png' })])
    } finally {
      setCapturing(false)
    }
  }

  async function send() {
    if (!ready) return
    setPhase({ kind: 'sending' })
    try {
      const { id } = await sendBugReport(await preparePayload(draft))
      resetDraft()
      setPreview(null)
      setPhase({ kind: 'sent', id })
    } catch (e) {
      setPhase({ kind: 'failed', reason: e instanceof BugSendError ? e.reason : 'offline' })
    }
  }

  async function save(email: boolean) {
    const name = await saveZip(await preparePayload(draft))
    setSaved(name)
    if (email) {
      const subject = encodeURIComponent(t('bugReport.emailSubject'))
      const body = encodeURIComponent(t('bugReport.emailBody', { file: name }))
      window.location.href = `mailto:${SAFETY_EMAIL}?subject=${subject}&body=${body}`
    }
  }

  if (phase.kind === 'sent') {
    return (
      <Modal title={t('bugReport.title')} onClose={closeBugReport}>
        <div className="bug-report-sent" role="status">
          <strong>{t('bugReport.thanks')}</strong>
          <p>{t('bugReport.thanksBody', { id: phase.id })}</p>
        </div>
        <div className="bug-report-actions">
          <button className="button primary" onClick={closeBugReport}>{t('common.done')}</button>
        </div>
      </Modal>
    )
  }

  const failed = phase.kind === 'failed' ? phase.reason : null
  return (
    <Modal
      title={t('bugReport.title')}
      onClose={closeBugReport}
      className={`bug-report ${capturing ? 'bug-report-capturing' : ''}`}
      footer={
        <>
          <button className="button" onClick={closeBugReport}>{t('common.cancel')}</button>
          <button className="button primary" onClick={() => void send()} disabled={!ready}>
            {phase.kind === 'sending' ? t('bugReport.sending') : t('bugReport.send')}
          </button>
        </>
      }
    >
      <div className="bug-report-form" onPaste={onPaste}>
        <p className="muted">{t('bugReport.intro')}</p>
        <label className="field">
          <span>{t('bugReport.what')}</span>
          <textarea value={draft.what} maxLength={MAX_WHAT} rows={3} required autoFocus placeholder={t('bugReport.whatPlaceholder')}
            onChange={(e) => updateDraft({ what: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('bugReport.steps')}</span>
          <textarea value={draft.steps} maxLength={MAX_STEPS} rows={4} onChange={(e) => updateDraft({ steps: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('bugReport.expected')}</span>
          <textarea value={draft.expected} maxLength={MAX_EXPECTED} rows={2} onChange={(e) => updateDraft({ expected: e.target.value })} />
        </label>

        <div className="field">
          <span id="bug-report-shots">{t('bugReport.screenshots')} <span className="muted">{t('bugReport.imageCount', { count: draft.images.length, max: MAX_IMAGES })}</span></span>
          <div className="bug-report-drop" role="group" aria-labelledby="bug-report-shots" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            {draft.images.length > 0 && (
              <ul className="bug-report-thumbs">
                {draft.images.map((image, i) => (
                  <li key={i}>
                    <img src={`data:${image.type};base64,${image.data}`} alt={t('bugReport.imageAlt', { n: i + 1 })} />
                    <button className="icon-button small" aria-label={t('bugReport.removeImage', { n: i + 1 })}
                      onClick={() => updateDraft({ images: draft.images.filter((_, j) => j !== i) })}>
                      <Close size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted bug-report-small">{t('bugReport.screenshotsHint', { max: MAX_IMAGES })}</p>
            <div className="bug-report-shot-buttons">
              <button type="button" className="button small" disabled={room <= 0} onClick={() => picker.current?.click()}>{t('bugReport.addPictures')}</button>
              {desktop?.captureApp && (
                <button type="button" className="button small" disabled={room <= 0} title={t('bugReport.takeScreenshotHint')} onClick={() => void screenshot()}>
                  {t('bugReport.takeScreenshot')}
                </button>
              )}
              {adding > 0 && <Spinner />}
            </div>
            <input ref={picker} type="file" accept="image/*" multiple hidden aria-label={t('bugReport.addPictures')}
              onChange={(e) => {
                void addBlobs([...(e.target.files ?? [])])
                e.target.value = ''
              }} />
          </div>
          {imageError && <p className="error-text" role="alert">{imageError}</p>}
        </div>

        <div className="bug-report-logs">
          <label className="checkbox">
            <input type="checkbox" checked={draft.includeLogs} onChange={(e) => updateDraft({ includeLogs: e.target.checked })} />
            {t('bugReport.includeLogs')}
          </label>
          <p className="muted bug-report-small">{t('bugReport.logsHint')}</p>
          <button type="button" className="bug-report-toggle" aria-expanded={preview !== null}
            onClick={() => (preview === null ? void preparePayload(draft).then((p) => setPreview(previewPayload(p))) : setPreview(null))}>
            {preview === null ? t('bugReport.seeIncluded') : t('bugReport.hideIncluded')}
          </button>
          {preview !== null && (
            <pre className="bug-report-preview" tabIndex={0} aria-label={t('bugReport.includedTitle')} data-testid="bug-report-preview">{preview}</pre>
          )}
        </div>

        <label className="field">
          <span>{t('bugReport.email')}</span>
          <input type="email" value={draft.email} maxLength={MAX_EMAIL} autoComplete="email" aria-invalid={emailBad}
            onChange={(e) => updateDraft({ email: e.target.value })} onBlur={() => setEmailTouched(true)} />
          <small className="muted">{t('bugReport.emailHint')}</small>
          {emailBad && <small className="error-text">{t('bugReport.badEmail')}</small>}
        </label>
        <p className="fine-print">{t('bugReport.where')}</p>

        {failed && (
          <div className="bug-report-failed" role="alert">
            <p>{t(`bugReport.failed.${failed}`)}</p>
            {failed !== 'tooLarge' && (
              <div className="bug-report-actions">
                <button className="button" onClick={() => void save(false)}>{t('bugReport.saveFile')}</button>
                <button className="button" onClick={() => void save(true)}>{t('bugReport.emailInstead')}</button>
              </div>
            )}
            {saved && <p className="muted bug-report-small" role="status">{t('bugReport.emailAttach', { file: saved })}</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}
