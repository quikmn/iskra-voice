// The new device's side of linking: scan the QR code (or type the code), compare the number, done.
import { useEffect, useState } from 'react'
import { parseLinkCode } from '../core/link'
import { cancelLinkJoin, joinWithCode, useLinkJoin } from '../state/link'
import { Spinner } from './bits'
import { QrScanner } from './QrScanner'

let autoStarted: string | null = null

export function LinkJoin({ initialCode, onBack }: { initialCode?: string | null; onBack: () => void }) {
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
        <p className="lead"><Spinner /> Waiting for your other device…</p>
        <p className="muted">Keep the code open there. A number will show up here to type in there.</p>
        <button type="button" className="button wide" onClick={back}>Cancel</button>
      </div>
    )
  }
  if (state.phase === 'confirm') {
    return (
      <div className="link-join">
        <p className="lead">Type this number on your other device:</p>
        <div className="confirm-code" data-testid="link-confirm">{state.confirm}</div>
        <p className="muted">It proves this device is yours. Nobody else can see it.</p>
        <button type="button" className="button wide" onClick={back}>Cancel</button>
      </div>
    )
  }
  if (state.phase === 'finishing') {
    return <p className="lead"><Spinner /> Setting up your account…</p>
  }

  return (
    <div className="link-join">
      <p className="lead">On a device where you're signed in, open <strong>Settings → Devices → Link a device</strong>.</p>
      {scanning ? (
        <QrScanner onResult={(text) => {
          setScanning(false)
          setCode(text)
          void joinWithCode(text)
        }} />
      ) : (
        <button type="button" className="button wide" onClick={() => setScanning(true)}>Scan the QR code</button>
      )}
      <label className="field link-code-field">
        <span>Or type the code</span>
        <textarea rows={2} value={code} onChange={(e) => setCode(e.target.value)} placeholder="server/XXXX-XXXX-…" spellCheck={false} autoComplete="off" />
      </label>
      {state.phase === 'error' && <p className="error-text">{state.message}</p>}
      <button type="button" className="button primary wide" disabled={!valid} onClick={() => void joinWithCode(code)}>Link this device</button>
      <p className="fine-print">
        <button type="button" className="link" onClick={back}>Back</button>
      </p>
    </div>
  )
}
