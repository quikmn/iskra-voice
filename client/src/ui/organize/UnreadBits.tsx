// The "New messages" divider and the bar that jumps up to it, for any conversation (state/readState.ts places them).
import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { dividerOf, markConversationRead, useRead } from '../../state/readState'
import { clockTime } from '../format'
import type { MessageRef } from '../../state/readState'
import { CATCH_UP_THRESHOLD } from '../../state/catchupLogic'
import { CatchUpButton, CatchUpPanel } from '../catchup/CatchUpPanel'
import type { CatchUpSpec } from '../catchup/sources'
import './organize.css'

/** `main`: the one in the main message list (it has the id the jump bar and tests look for). */
export function UnreadDivider({ main = true }: { main?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="unread-divider" id={main ? 'unread-divider' : undefined} role="separator" aria-label={t('organize.unread.newMessages')}>
      <span>{t('organize.unread.newMessages')}</span>
    </div>
  )
}

export function UnreadBar({ conv, scroller, onJump, loadOlder, catchUp }: {
  conv: string
  scroller: RefObject<HTMLDivElement | null>
  onJump: () => void
  /** Loads an older page; resolves to whether there's more. */
  loadOlder?: () => Promise<boolean>
  /** Offers "Catch up" (a summary of what's new) when a lot is unread. */
  catchUp?: { spec: CatchUpSpec; title: string }
}) {
  const { t } = useTranslation()
  const divider = dividerOf(useRead(conv))
  const showing = !!divider
  const [above, setAbove] = useState(false)
  const [summary, setSummary] = useState<MessageRef | null>(null)
  const many = !!catchUp && !!divider && divider.count >= CATCH_UP_THRESHOLD
  const panel = summary && catchUp && <CatchUpPanel spec={catchUp.spec} from={summary} title={catchUp.title} onClose={() => setSummary(null)} />
  const find = () => scroller.current?.querySelector<HTMLElement>('.unread-divider') ?? null

  useEffect(() => {
    const el = scroller.current
    if (!el || !showing) return
    const check = () => {
      const line = el.querySelector<HTMLElement>('.unread-divider')
      setAbove(!line || line.getBoundingClientRect().bottom < el.getBoundingClientRect().top + 4)
    }
    check()
    el.addEventListener('scroll', check, { passive: true })
    const timer = setInterval(check, 500) // new messages and images move things around
    return () => {
      el.removeEventListener('scroll', check)
      clearInterval(timer)
    }
  }, [scroller, showing])

  // With a lot unread the bar stays (for Catch up) even when the divider is in view.
  if (!divider || (!above && !many)) return <>{null}{panel}</>

  async function jump() {
    onJump()
    // Older pages until the first new message is loaded.
    for (let i = 0; i < 20 && !find() && loadOlder; i++) {
      if (!(await loadOlder())) break
      await new Promise((r) => setTimeout(r, 30))
    }
    await new Promise((r) => setTimeout(r, 30))
    find()?.scrollIntoView({ block: 'center' })
  }

  return (
    <>
    <div className="unread-bar-wrap"><div className="unread-bar" role="status">
      <button className="unread-bar-jump" onClick={() => void jump()}>
        {t('organize.unread.bar', { count: divider.count, time: clockTime(divider.from.at) })}
      </button>
      {many && <CatchUpButton onClick={() => setSummary(divider.from)} />}
      <button className="unread-bar-read" onClick={() => markConversationRead(conv)}>{t('organize.unread.markRead')}</button>
    </div></div>
    {panel}
    </>
  )
}
