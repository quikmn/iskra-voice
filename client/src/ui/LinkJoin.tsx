// The new device's side of linking: scan the QR code (or type the code), compare the number, done.
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { parseLinkCode } from '../core/link'
import { cancelLinkJoin, joinWithCode, useLinkJoin } from '../state/link'
import { Spinner } from './bits'
import { QrScanner } from './QrScanner'

let autoStarted: string | null = null

export function LinkJoin({ initialCode, onBack }: { initialCode?: string | null; onBack: () => void }) {
  const { t } = useTranslation()
  const state = useLinkJoin()
  const [code, setCode] = useState(initialCode ?? '')
  const [scanning, setScanning] = useState(false)
  const valid = parseLinkCode(code) !== null

  useEffect(() => {
    // Opened from the QR code's link: start right away (once, even under StrictMode).
    if (initialCode && autoStarted !== initialCode) {
      autoStarted = initialCode
      void joinWithCode(initialCode)
    }
  }, [initialCode])

  function back() {
    cancelLinkJoin()
    onBack()
  }

  if (state.phase === 'connecting') {
    return (
      <div className="link-join">
        <p className="lead"><Spinner /> {t('app.link.waiting')}</p>
        <p className="muted">{t('app.link.waitingHint')}</p>
        <button type="button" className="button wide" onClick={back}>{t('common.cancel')}</button>
      </div>
    )
  }
  if (state.phase === 'confirm') {
    return (
      <div className="link-join">
        <p className="lead">{t('app.link.typeNumber')}</p>
        <div className="confirm-code" data-testid="link-confirm">{state.confirm}</div>
        <p className="muted">{t('app.link.typeNumberHint')}</p>
        <button type="button" className="button wide" onClick={back}>{t('common.cancel')}</button>
      </div>
    )
  }
  if (state.phase === 'history') {
    return (
      <div className="link-progress" role="status">
        <p className="lead"><Spinner /> {t('app.link.history', { percent: Math.round((100 * state.received) / state.total) })}</p>
        <progress max={state.total} value={state.received} aria-label={t('app.link.historyReceived')} />
      </div>
    )
  }
  if (state.phase === 'finishing') {
    return <p className="lead"><Spinner /> {t('app.link.finishing')}</p>
  }

  return (
    <div className="link-join">
      <p className="lead link-howto"><Trans i18nKey="app.link.howTo" components={{ b: <strong /> }} /></p>
      {scanning ? (
        <QrScanner onResult={(text) => {
          setScanning(false)
          setCode(text)
          void joinWithCode(text)
        }} />
      ) : (
        <button type="button" className="button wide" onClick={() => setScanning(true)}>{t('app.link.scan')}</button>
      )}
      <label className="field link-code-field">
        <span>{t('app.link.typeCode')}</span>
        <textarea rows={2} value={code} onChange={(e) => setCode(e.target.value)} placeholder="server/XXXX-XXXX-…" spellCheck={false} autoComplete="off" />
      </label>
      {state.phase === 'error' && <p className="error-text">{state.message}</p>}
      <button type="button" className="button primary wide" disabled={!valid} onClick={() => void joinWithCode(code)}>{t('app.link.linkThis')}</button>
      <p className="fine-print">
        <button type="button" className="link" onClick={back}>{t('common.back')}</button>
      </p>
    </div>
  )
}
