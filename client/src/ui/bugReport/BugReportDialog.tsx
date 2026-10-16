// "Report a bug" (Help → Report a bug, the status menu, Ctrl+Shift+B): what happened, steps, what you expected,
// screenshots (paste, drop, pick, or on desktop a picture of one of Iskra's own windows, now or in 5 seconds), logs on
// by default with a view of exactly what's sent, an optional email. Sent to Iskra's bug inbox; if that fails, saved as
// a zip to email instead.
// It opens in a window of its own (desktop app; Chromium's Document Picture-in-Picture), so you can keep using the
// app to show the bug; elsewhere in the page, where "Keep using Iskra" tucks it into a chip. The draft lives in the
// store either way, so closing and opening it again loses nothing.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { desktop } from '../../platform/desktop'
import { native } from '../../platform/native'
import { SAFETY_EMAIL } from '../../state/terms'
import { closeBugReport, openBugReport, preparePayload, resetDraft, tuckBugReport, untuckBugReport, updateDraft, useBugReport } from '../../state/bugReport/bugReport'
import { prepareImage } from '../../state/bugReport/images'
import { canSend, MAX_EMAIL, MAX_EXPECTED, MAX_IMAGES, MAX_STEPS, MAX_WHAT, previewPayload, reportFiles, validEmail, type ReportPayload } from '../../state/bugReport/payload'
import { CAPTURE_DELAY_SECONDS, pngFromDataUrl, startCountdown } from '../../state/bugReport/reportWindow'
import { BugSendError, sendBugReport, type SendFailure } from '../../state/bugReport/send'
import { makeZip } from '../../state/bugReport/zip'
import { captureTargets } from '../../state/popoutLogic'
import { focusPopout, popoutRoot, usePopouts, type Popout } from '../../state/popouts'
import { Modal, Spinner } from '../bits'
import { Close } from '../icons'
import { PopoutFrame, usePopoutTitle } from '../popout/PopoutLayer'
import './bugReport.css'

/** Mounted once: the report (its window or the dialog), the chip, and Ctrl+Shift+B (Cmd+Shift+B on a Mac). */
export function BugReportLayer() {
  const open = useBugReport((s) => s.open)
  const tucked = useBugReport((s) => s.tucked)
  const report = usePopouts((s) => s.open.find((p) => p.target.kind === 'report'))
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
  const root = report ? popoutRoot(report.id) : null
  return (
    <>
      {report && root && createPortal(
        <PopoutFrame popout={report}>
          <BugReport place="window" popoutId={report.id} />
        </PopoutFrame>,
        root, report.id,
      )}
      {!report && open && <BugReport place="page" />}
      {!report && !open && tucked && <BugReportChip />}
    </>
  )
}

/** "Keep using Iskra": the report waits here. Tapping it (or its ×) brings the report back; discarding is in there. */
function BugReportChip() {
  const { t } = useTranslation()
  const count = useBugReport((s) => s.draft.images.length)
  return (
    <div className="bug-report-chip" role="region" aria-label={t('bugReport.title')} data-testid="bug-report-chip">
      <button className="bug-report-chip-open" onClick={untuckBugReport}>
        {count ? t('bugReport.chipShots', { count }) : t('bugReport.chip')}
      </button>
      <button className="icon-button small" onClick={untuckBugReport} aria-label={t('bugReport.chipBack')} title={t('bugReport.chipBack')}>
        <Close size={14} />
      </button>
    </div>
  )
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

/** The report's surroundings: the dialog in the page, or the body and buttons of its own window. */
function Shell({ place, className, footer, children }: { place: 'page' | 'window'; className?: string; footer: ReactNode; children: ReactNode }) {
  const { t } = useTranslation()
  if (place === 'page') {
    return <Modal title={t('bugReport.title')} onClose={closeBugReport} className={className} footer={footer}>{children}</Modal>
  }
  return (
    <div className={`bug-report-window ${className ?? ''}`} role="form" aria-label={t('bugReport.title')}>
      <div className="bug-report-window-body">{children}</div>
      <footer className="bug-report-window-footer">{footer}</footer>
    </div>
  )
}

function BugReport({ place, popoutId }: { place: 'page' | 'window'; popoutId?: string }) {
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
    const free = MAX_IMAGES - useBugReport.getState().draft.images.length - adding
    const take = images.slice(0, Math.max(0, free))
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

  /** A picture of one of Iskra's own windows (desktop only): the main one, or a pop-out. */
  async function screenshot(target: string) {
    if (!desktop?.captureWindow) return
    // In the page, the dialog steps aside so the picture shows the app, not this form.
    const stepAside = place === 'page' && target === 'main'
    if (stepAside) setCapturing(true)
    try {
      if (stepAside) await new Promise((resolve) => setTimeout(resolve, 200))
      const blob = pngFromDataUrl(await desktop.captureWindow(target).catch(() => null))
      if (blob) await addBlobs([blob])
      else setImageError(t('bugReport.captureFailed'))
    } finally {
      if (stepAside) setCapturing(false)
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
      <Shell place={place} footer={<button className="button primary" onClick={closeBugReport}>{t('common.done')}</button>}>
        <div className="bug-report-sent" role="status">
          <strong>{t('bugReport.thanks')}</strong>
          <p>{t('bugReport.thanksBody', { id: phase.id })}</p>
        </div>
      </Shell>
    )
  }

  const failed = phase.kind === 'failed' ? phase.reason : null
  return (
    <Shell
      place={place}
      className={`bug-report ${capturing ? 'bug-report-capturing' : ''}`}
      footer={
        <>
          {place === 'page' && (
            <button className="button bug-report-keep" onClick={tuckBugReport} title={t('bugReport.keepUsingHint')}>{t('bugReport.keepUsing')}</button>
          )}
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
              {adding > 0 && <Spinner />}
            </div>
            {desktop?.captureWindow && (
              <WindowShot disabled={room <= 0} delayed={place === 'window'} onShoot={screenshot}
                onDelayedDone={() => popoutId && focusPopout(popoutId)} />
            )}
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
    </Shell>
  )
}

/**
 * Desktop: a picture of one of Iskra's own windows (the main one or an open pop-out), now or in 5 seconds. The
 * countdown never moves focus, so a menu opened in the main window meanwhile is still open when it's taken.
 */
function WindowShot({ disabled, delayed, onShoot, onDelayedDone }: {
  disabled: boolean
  /** "In 5 seconds" (the report's own window; in the page, the dialog would be in the way). */
  delayed: boolean
  onShoot: (target: string) => Promise<void>
  onDelayedDone: () => void
}) {
  const { t } = useTranslation()
  const open = usePopouts((s) => s.open)
  const others = captureTargets(open)
  const [choice, setChoice] = useState('main')
  const [left, setLeft] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const cancel = useRef<(() => void) | null>(null)
  // The window that was picked closed: back to the main one.
  const target = choice === 'main' || others.some((p) => p.id === choice) ? choice : 'main'
  useEffect(() => () => cancel.current?.(), [])

  const shoot = async (then?: () => void) => {
    setBusy(true)
    try {
      await onShoot(target)
    } finally {
      setBusy(false)
      then?.()
    }
  }
  const startDelayed = () => {
    cancel.current = startCountdown(CAPTURE_DELAY_SECONDS, setLeft, () => {
      cancel.current = null
      setLeft(null)
      void shoot(onDelayedDone)
    })
  }
  const stop = () => {
    cancel.current?.()
    cancel.current = null
    setLeft(null)
  }

  return (
    <div className="bug-report-window-shot">
      <label className="bug-report-target">
        <span>{t('bugReport.screenshotOf')}</span>
        <select value={target} onChange={(e) => setChoice(e.target.value)} disabled={left !== null}>
          <option value="main">{t('bugReport.target.main')}</option>
          {others.map((p) => <TargetOption key={p.id} popout={p} />)}
        </select>
      </label>
      {left === null ? (
        <div className="bug-report-shot-buttons">
          <button type="button" className="button small" disabled={disabled || busy} title={t('bugReport.takeScreenshotHint')} onClick={() => void shoot()}>
            {t('bugReport.takeScreenshot')}
          </button>
          {delayed && (
            <button type="button" className="button small" disabled={disabled || busy} title={t('bugReport.delayedHint')} onClick={startDelayed}>
              {t('bugReport.delayed', { seconds: CAPTURE_DELAY_SECONDS })}
            </button>
          )}
        </div>
      ) : (
        <div className="bug-report-countdown">
          <span role="status" aria-live="polite" data-testid="bug-report-countdown">{t('bugReport.countdown', { seconds: left })}</span>
          <button type="button" className="button small" onClick={stop}>{t('common.cancel')}</button>
        </div>
      )}
    </div>
  )
}

function TargetOption({ popout }: { popout: Popout }) {
  const { t } = useTranslation()
  const title = usePopoutTitle(popout)
  const kind = popout.target.kind === 'report' ? 'main' : popout.target.kind
  return <option value={popout.id}>{t(`bugReport.target.${kind}`, { title })}</option>
}
