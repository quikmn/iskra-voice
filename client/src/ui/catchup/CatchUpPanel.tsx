// "What did I miss?": a summary of the unread stretch, made on this device (see state/catchupLogic.ts). Every item jumps
// to its message.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageRef } from '../../state/readState'
import { catchUp, type CatchUpResult } from '../../state/catchup'
import { overviewText, type CatchUpItem, type Reason } from '../../state/catchupLogic'
import { errorMessage } from '../../i18n/errors'
import { Avatar, Modal, Spinner } from '../bits'
import { clockTime, fullTime, messageTime } from '../format'
import { plainText } from '../markdown'
import { SparkIcon } from '../docs/icons'
import { jumpTo, loadSpan, nameFor, type CatchUpSpec } from './sources'
import './catchup.css'

export function CatchUpButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button className="catchup-button" onClick={onClick} title={t('catchup.buttonTitle')}>
      <SparkIcon size={14} /> {t('catchup.button')}
    </button>
  )
}

const REASON_ORDER: Reason[] = ['mention', 'replyToYou', 'pinned', 'poll', 'reactions', 'replies', 'thread', 'link', 'image', 'file']

export function CatchUpPanel({ spec, from, title, onClose }: { spec: CatchUpSpec; from: MessageRef; title: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [result, setResult] = useState<CatchUpResult | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        const span = await loadSpan(spec, from, abort.signal)
        setCount(span.messages.length)
        setNames(span.names)
        setResult(await catchUp(span.messages, abort.signal))
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(errorMessage(e))
      }
    })()
    return () => abort.abort()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- one summary per opening

  const name = (key: string) => nameFor(spec, key, names)
  const nameCtx = useMemo(() => ({ nameOf: (k: string) => nameFor(spec, k, names) }), [spec, names])

  function go(id: number | string) {
    onClose()
    jumpTo(spec, id)
  }

  const reasonText = (item: CatchUpItem, reason: Reason): string => {
    switch (reason) {
      case 'reactions': return t('catchup.reasons.reactions', { count: item.reactions })
      case 'replies': return t('catchup.reasons.replies', { count: item.replies })
      case 'thread': return t('catchup.reasons.thread')
      default: return t(`catchup.reasons.${reason}`)
    }
  }

  const renderItem = (item: CatchUpItem, key: string) => (
    <li key={key}>
      <button className="catchup-item" onClick={() => go(item.id)}>
        <Avatar name={name(item.author)} accountKey={item.author} size={28} />
        <span className="catchup-item-body">
          <span className="catchup-item-meta">
            <strong>{name(item.author)}</strong>
            <time title={fullTime(item.at)}>{messageTime(item.at)}</time>
          </span>
          <span className="catchup-excerpt">{item.excerpt ? plainText(item.excerpt, nameCtx) : t('catchup.attachmentOnly')}</span>
          <span className="catchup-reasons">
            {REASON_ORDER.filter((r) => item.reasons.includes(r) && !(r === 'replyToYou' && item.reasons.includes('mention')))
              .map((r) => <span key={r} className={`catchup-chip ${r}`}>{reasonText(item, r)}</span>)}
          </span>
        </span>
      </button>
    </li>
  )

  const section = (heading: string, items: CatchUpItem[]) => items.length === 0 ? null : (
    <section className="catchup-section" aria-label={heading}>
      <h3>{heading}</h3>
      <ul className="catchup-list">{items.map((item) => renderItem(item, `${heading}-${item.id}`))}</ul>
    </section>
  )

  const o = result?.overview
  return (
    <Modal title={t('catchup.title')} heading={<span className="catchup-heading"><SparkIcon size={18} /> {t('catchup.title')}</span>} wide className="catchup-modal" onClose={onClose}
      footer={<button className="button" onClick={onClose}>{t('common.close')}</button>}>
      <p className="catchup-where muted">{t('catchup.in', { name: title })}</p>
      {error ? (
        <p className="error-text">{error}</p>
      ) : !result || !o ? (
        <div className="catchup-loading"><Spinner /><span className="muted">{count === null ? t('catchup.loading') : t('catchup.reading', { count })}</span></div>
      ) : o.messages === 0 ? (
        <p>{t('catchup.nothing')}</p>
      ) : (
        <>
          <p className="catchup-overview">{overviewText(o, t as never)}</p>
          {result.prose && <p className="catchup-prose">{result.prose}</p>}
          <p className="catchup-note muted">{t('catchup.local')}</p>
          {section(t('catchup.sections.forYou'), result.forYou)}
          {section(t('catchup.sections.highlights'), result.highlights.filter((h) => !result.forYou.some((f) => f.id === h.id)))}
          {section(t('catchup.sections.pinned'), result.pinned)}
          {section(t('catchup.sections.polls'), result.polls)}
          {section(t('catchup.sections.shared'), result.shared)}
          {result.people.length > 0 && (
            <section className="catchup-section" aria-label={t('catchup.sections.people')}>
              <h3>{t('catchup.sections.people')}</h3>
              <ul className="catchup-people">
                {result.people.slice(0, 12).map((p) => (
                  <li key={p.author} className="catchup-person">
                    <Avatar name={name(p.author)} accountKey={p.author} size={24} />
                    <span>{name(p.author)}</span>
                    <span className="catchup-count">{p.count}</span>
                  </li>
                ))}
                {result.people.length > 12 && <li className="catchup-person muted">{t('catchup.morePeople', { count: result.people.length - 12 })}</li>}
              </ul>
            </section>
          )}
          {result.busy.length > 0 && (
            <section className="catchup-section" aria-label={t('catchup.sections.busy')}>
              <h3>{t('catchup.sections.busy')}</h3>
              <ul className="catchup-list">
                {result.busy.map((b) => (
                  <li key={String(b.firstId)}>
                    <button className="catchup-stretch" onClick={() => go(b.firstId)}>
                      <span className="catchup-stretch-time">{clockTime(b.start)}–{clockTime(b.end)}</span>
                      <span className="muted">{t('catchup.stretch', { count: b.count })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Modal>
  )
}
