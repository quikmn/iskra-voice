// A poll inside a message (vote, live results, end early) and the dialog that creates one.
import { useEffect, useState } from 'react'
import { roleRank, type Message } from '../../core/protocol'
import { createPoll, endPoll, votePoll } from '../../state/expressions'
import type { ServerState } from '../../state/store'
import { Modal } from '../bits'
import { Close, Plus } from '../icons'
import { Check } from './icons'
import { isPollClosed, myVotes, POLL_DURATIONS, POLL_LIMITS, pollProblem, pollResults, timeLeft } from './poll'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function PollCard({ server, message }: { server: ServerState; message: Message }) {
  const { t } = useTranslation()
  const poll = message.poll!
  const me = server.me
  const now = useNow(poll.expiresAt !== null && poll.closedAt === null)
  const closed = isPollClosed(poll, now)
  const mine = myVotes(poll, me?.accountKey)
  const voted = mine.length > 0
  const [selected, setSelected] = useState<number[]>([])
  const [peek, setPeek] = useState(false)
  const [changing, setChanging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const results = pollResults(poll)
  const showResults = closed || peek || (voted && !changing)
  const author = server.members[message.author]
  const canEnd = !!me && !closed && (message.author === me.accountKey ||
    (roleRank(me.role) >= roleRank('admin') && (!author || roleRank(me.role) > roleRank(author.role))))

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function toggle(index: number) {
    setSelected((current) =>
      poll.multi ? (current.includes(index) ? current.filter((i) => i !== index) : [...current, index]) : [index])
  }

  const vote = () => run(async () => {
    await votePoll(server.key, message.id, [...selected].sort((a, b) => a - b))
    setChanging(false)
    setPeek(false)
  })

  const status = closed
    ? poll.closedAt !== null && (poll.expiresAt === null || poll.closedAt < poll.expiresAt) ? t('expressions.poll.endedEarly') : t('expressions.poll.closed')
    : poll.expiresAt !== null ? timeLeft(poll.expiresAt - now) : null

  return (
    <div className={`poll ${closed ? 'closed' : ''}`} role="group" aria-label={t('expressions.poll.label', { question: poll.question })}>
      <div className="poll-question">{poll.question}</div>
      <div className="poll-hint muted">
        {closed ? t('expressions.poll.finalResults') : showResults ? t('expressions.poll.resultsSoFar') : poll.multi ? t('expressions.poll.selectMany') : t('expressions.poll.selectOne')}
      </div>
      <ul className="poll-options">
        {poll.options.map((option, i) => {
          const isMine = mine.includes(i)
          const leading = closed && results.leaders.includes(i)
          if (showResults) {
            const names = option.votes.map((k) => server.members[k]?.name ?? t('common.someone'))
            return (
              <li key={i} className={`poll-result ${isMine ? 'mine' : ''} ${leading ? 'leading' : ''}`}
                title={names.length
                  ? names.length > 15 ? t('expressions.poll.votersMore', { names: names.slice(0, 15).join(', '), count: names.length - 15 }) : names.join(', ')
                  : t('expressions.poll.noVotes')}>
                <span className="poll-bar" style={{ width: `${results.percents[i]}%` }} />
                <span className="poll-option-text">{option.text}</span>
                {isMine && <span className="poll-check" aria-label={t('expressions.poll.yourVote')}><Check size={14} /></span>}
                <span className="poll-count">{results.counts[i]} · {results.percents[i]}%</span>
              </li>
            )
          }
          const isSelected = selected.includes(i)
          return (
            <li key={i}>
              <button
                className={`poll-choice ${isSelected ? 'selected' : ''}`}
                role={poll.multi ? 'checkbox' : 'radio'}
                aria-checked={isSelected}
                disabled={busy}
                onClick={() => toggle(i)}
              >
                <span className={`poll-marker ${poll.multi ? 'square' : ''}`}>{isSelected && <Check size={12} />}</span>
                <span className="poll-option-text">{option.text}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="poll-footer">
        <span className="muted">
          {t('expressions.poll.votes', { count: results.voters })}{status ? ` · ${status}` : ''}
        </span>
        <span className="spacer" />
        {!closed && !showResults && (
          <>
            {!voted && <button className="link" onClick={() => setPeek(true)}>{t('expressions.poll.showResults')}</button>}
            {changing && <button className="link" onClick={() => setChanging(false)}>{t('common.cancel')}</button>}
            <button className="button primary small" disabled={busy || selected.length === 0} onClick={() => void vote()}>{t('expressions.poll.vote')}</button>
          </>
        )}
        {!closed && showResults && peek && !voted && <button className="link" onClick={() => setPeek(false)}>{t('expressions.poll.backToVoting')}</button>}
        {!closed && showResults && voted && !peek && (
          <>
            <button className="link" disabled={busy} onClick={() => void run(() => votePoll(server.key, message.id, []))}>{t('expressions.poll.removeVote')}</button>
            <button className="link" disabled={busy} onClick={() => { setSelected(mine); setChanging(true) }}>{t('expressions.poll.changeVote')}</button>
          </>
        )}
        {canEnd && <button className="link danger-link" disabled={busy} onClick={() => void run(() => endPoll(server.key, message.id))}>{t('expressions.poll.end')}</button>}
      </div>
      {error && <div className="message-failed">{error}</div>}
    </div>
  )
}

export function PollDialog({ server, channelId, onClose }: { server: ServerState; channelId: number; onClose: () => void }) {
  const { t } = useTranslation()
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [duration, setDuration] = useState<number | null>(24 * 3_600_000)
  const [multi, setMulti] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = pollProblem(question, options)

  async function post() {
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await createPoll(server.key, channelId, {
        question: question.trim(), options: options.map((o) => o.trim()).filter(Boolean), multi, durationMs: duration ?? undefined,
      })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const setOption = (i: number, value: string) => setOptions((list) => list.map((o, j) => (j === i ? value : o)))

  return (
    <Modal
      title={t('expressions.poll.create')}
      onClose={onClose}
      footer={
        <>
          {error && <span className="error-text">{error}</span>}
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={busy || !!problem} onClick={() => void post()}>{t('expressions.poll.post')}</button>
        </>
      }
    >
      <label className="field">
        <span>{t('expressions.poll.question')}</span>
        <input value={question} maxLength={POLL_LIMITS.question} placeholder={t('expressions.poll.questionPlaceholder')} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <div className="field">
        <span>{t('expressions.poll.answers')}</span>
        <div className="poll-editor">
          {options.map((option, i) => (
            <div key={i} className="copy-row">
              <input
                value={option}
                maxLength={POLL_LIMITS.option}
                aria-label={t('expressions.poll.answer', { n: i + 1 })}
                placeholder={t('expressions.poll.answer', { n: i + 1 })}
                onChange={(e) => setOption(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && i === options.length - 1 && options.length < POLL_LIMITS.maxOptions && option.trim()) {
                    e.preventDefault()
                    setOptions((list) => [...list, ''])
                  }
                }}
                autoFocus={i === options.length - 1 && i >= 2}
              />
              {options.length > POLL_LIMITS.minOptions && (
                <button className="icon-button small" aria-label={t('expressions.poll.removeAnswer', { n: i + 1 })} onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}>
                  <Close size={14} />
                </button>
              )}
            </div>
          ))}
          {options.length < POLL_LIMITS.maxOptions && (
            <button className="button add-answer" onClick={() => setOptions((list) => [...list, ''])}>
              <Plus size={14} /> {t('expressions.poll.addAnswer')}
            </button>
          )}
        </div>
      </div>
      <div className="copy-row poll-settings">
        <label className="field">
          <span>{t('expressions.poll.duration')}</span>
          <select value={duration ?? ''} onChange={(e) => setDuration(e.target.value ? Number(e.target.value) : null)}>
            {POLL_DURATIONS.map((d) => <option key={d.id} value={d.ms ?? ''}>{t(`expressions.poll.durations.${d.id}`)}</option>)}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
          {t('expressions.poll.multi')}
        </label>
      </div>
    </Modal>
  )
}
