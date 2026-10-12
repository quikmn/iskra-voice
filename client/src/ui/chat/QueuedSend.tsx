// Enter while a file is still uploading: the send waits, says so, and goes out when the upload finishes.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** What to do once a queued send's uploads are no longer running: send, or drop it (a file failed, so the person decides). */
export function queuedOutcome(uploads: { done: boolean; failed: boolean }[]): 'wait' | 'send' | 'drop' {
  if (uploads.some((u) => !u.done && !u.failed)) return 'wait'
  return uploads.some((u) => u.failed) ? 'drop' : 'send'
}

/** `send` is the composer's own submit; it runs with the composer's state as it is when the uploads are done. */
export function useQueuedSend(uploads: { done: boolean; failed: boolean }[], send: () => void) {
  const { t } = useTranslation()
  const [queued, setQueued] = useState(false)
  const latest = useRef(send)
  latest.current = send
  const outcome = queuedOutcome(uploads)
  useEffect(() => {
    if (!queued || outcome === 'wait') return
    setQueued(false)
    if (outcome === 'send') latest.current()
  }, [queued, outcome])
  const bar = queued ? (
    <div className="queued-send" role="status">
      <span>{t('chat.composer.queued')}</span>
      <button className="link" onClick={() => setQueued(false)} aria-label={t('chat.composer.queuedCancel')}>{t('common.cancel')}</button>
    </div>
  ) : null
  return { queued, queue: () => setQueued(true), bar }
}
