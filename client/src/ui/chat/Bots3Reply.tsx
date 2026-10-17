// What Tags, Suggestions, Giveaways and Counting post, worded in the app's language: a tag's snippet, suggestion cards
// with votes (and staff decisions), the Suggest prompt, giveaway cards with Enter, win announcements, the counting card
// and lines, and their private answers. Text from people (snippets, ideas, prizes, reasons) is rendered by React.
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Bots3Reply as Reply, BuiltinReply, SuggestionStatus } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import {
  createSuggestion, decideSuggestion, enterGiveaway, giveawayAction, suggestionAuthor, useCardsMine, voteSuggestion, wantCard,
} from '../../state/bots3'
import { applyVote, giveawayOpen, MAX_REASON, MAX_SUGGESTION, nextVote } from '../../state/bots3Logic'
import { jumpToMessage } from '../../state/jump'
import { nameList } from '../../state/moreBuiltinBotsLogic'
import { useRoleLookup } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { useEmojiLookup } from '../expressions/useEmojiLookup'
import { renderMarkdown } from '../markdown'
import { whenText } from '../productivity/WhenPicker'
import '../bots3.css'

type R<K extends Reply['kind']> = BuiltinReply & Extract<Reply, { kind: K }>

export function Bots3Reply({ server, reply, messageId }: {
  server: ServerState
  reply: BuiltinReply & Reply
  /** The bot's message (absent for private answers). */
  messageId?: number
}) {
  const { t, i18n } = useTranslation()
  const nameOf = (key: string) => server.members[key]?.name ?? null
  const someone = t('chat.author.formerMember')
  const names = (keys: string[]) => nameList(keys.map((k) => nameOf(k) ?? someone), i18n.language)
  const line = (text: string, className = '') => <div className={`message-text builtin-reply ${className}`}>{text}</div>

  switch (reply.kind) {
    case 'tag':
      return <TagPost server={server} reply={reply} />
    case 'tag.list':
      return reply.names.length === 0 ? line(t('bots3.card.tagListNone')) : (
        <div className="message-text builtin-reply">
          {t('bots3.card.tagList')}
          <span className="bots3-tag-names">{reply.names.map((n) => <code key={n}>{n}</code>)}</span>
        </div>
      )
    case 'tag.saved': return line(t('bots3.card.tagSaved', { name: reply.name }))
    case 'tag.removed': return line(t('bots3.card.tagRemoved', { name: reply.name }))
    case 'tag.unknown': return line(t('bots3.card.tagUnknown', { name: reply.name }))
    case 'tag.usage': return line(t('bots3.card.tagUsage'))
    case 'suggestion':
      return messageId ? <SuggestionCard server={server} reply={reply} messageId={messageId} /> : null
    case 'suggestion.prompt':
      return <SuggestPrompt server={server} />
    case 'suggestion.posted':
      return (
        <div className="message-text builtin-reply">
          {t('bots3.card.posted', { channel: server.channels.find((c) => c.id === reply.channelId)?.name ?? '' })}{' '}
          <button type="button" className="link" onClick={() => void jumpToMessage(server.key, reply.channelId, reply.messageId)}>{t('bots3.card.show')}</button>
        </div>
      )
    case 'suggestion.usage': return line(t('bots3.card.suggestionUsage'))
    case 'suggestion.decided': {
      const status = t(`bots3.card.status.${reply.status}`).toLocaleLowerCase(i18n.language)
      return line(reply.reason ? t('bots3.card.decidedReason', { status, reason: reply.reason }) : t('bots3.card.decided', { status }))
    }
    case 'giveaway':
      return messageId ? <GiveawayCard server={server} reply={reply} messageId={messageId} /> : null
    case 'giveaway.won':
      return line(t(reply.reroll ? 'bots3.card.rerolled' : 'bots3.card.won', { names: names(reply.winners), prize: reply.prize }), 'giveaway-won')
    case 'giveaway.none': return line(t('bots3.card.none', { prize: reply.prize }))
    case 'giveaway.usage': return line(t('bots3.card.giveawayUsage'))
    case 'counting.card':
      return (
        <div className="bots3-card counting-card" data-testid="counting-card">
          <strong>{t('bots3.card.counting')}</strong>
          <span>{t('bots3.card.countingRules')}{reply.math && <> {t('bots3.card.countingMath')}</>}</span>
          <span className="counting-best">{t('bots3.card.best', { best: reply.best })}</span>
        </div>
      )
    case 'counting.broken': {
      const name = nameOf(reply.for) ?? someone
      return line(reply.reason === 'double'
        ? t('bots3.card.brokenDouble', { name, count: reply.count })
        : t('bots3.card.brokenWrong', { name, count: reply.count, said: reply.said, expected: reply.expected }), 'counting-line')
    }
    case 'counting.changed': {
      const name = nameOf(reply.for) ?? someone
      return line(t(reply.how === 'edited' ? 'bots3.card.changedEdited' : 'bots3.card.changedDeleted', { name, count: reply.count, next: reply.next }), 'counting-line')
    }
    case 'counting.start': return line(t('bots3.card.countingStart'))
  }
}

function TagPost({ server, reply }: { server: ServerState; reply: R<'tag'> }) {
  const { t } = useTranslation()
  const emoji = useEmojiLookup(server.key)
  const roleOf = useRoleLookup(server.key, server.me)
  return (
    <div className="tag-post" data-testid="tag-post">
      <span className="tag-post-name">{t('bots3.card.tagFrom', { name: reply.name })}</span>
      <div className="message-text">
        {renderMarkdown(reply.text, { nameOf: (k) => server.members[k]?.name ?? null, me: server.me?.accountKey, emoji, roleOf, serverKey: server.key })}
      </div>
    </div>
  )
}

const STATUSES: SuggestionStatus[] = ['accepted', 'declined', 'implemented', 'open']

function SuggestionCard({ server, reply, messageId }: { server: ServerState; reply: R<'suggestion'>; messageId: number }) {
  const { t } = useTranslation()
  const mine = useCardsMine((s) => s[server.key])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState(false)
  const [status, setStatus] = useState<SuggestionStatus>('accepted')
  const [reason, setReason] = useState('')
  const [author, setAuthor] = useState<string | null | undefined>(undefined)
  // A vote shows right away; once the card's counts change (the server's answer), the card's own numbers count again.
  const [pending, setOptimistic] = useState<{ vote: 1 | -1 | 0; up: number; down: number; base: string } | null>(null)
  useEffect(() => wantCard(server.key, messageId), [server.key, messageId])
  const base = `${reply.up}/${reply.down}`
  const optimistic = pending?.base === base ? pending : null

  const nameOf = (key: string | null) => (key && server.members[key]?.name) || t('chat.author.formerMember')
  const myVote = optimistic?.vote ?? mine?.votes[messageId] ?? 0
  const counts = optimistic ?? { up: reply.up, down: reply.down }
  const open = reply.status === 'open'
  const staff = !!mine?.staff.suggestions

  async function vote(clicked: 1 | -1) {
    const to = nextVote(myVote, clicked)
    setOptimistic({ vote: to, ...applyVote({ up: reply.up, down: reply.down }, mine?.votes[messageId] ?? 0, to), base })
    setError(null)
    try {
      await voteSuggestion(server.key, messageId, to)
    } catch (e) {
      setOptimistic(null)
      setError(errorMessage(e))
    }
  }

  async function decide(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await decideSuggestion(server.key, messageId, status, status === 'open' ? '' : reason)
      setDeciding(false)
      setReason('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function lookUp() {
    try {
      setAuthor(await suggestionAuthor(server.key, messageId))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className={`bots3-card suggestion-card status-${reply.status}`} data-testid="suggestion-card">
      <div className="bots3-card-head">
        {reply.anonymous ? t('bots3.card.suggestionAnonymous') : t('bots3.card.suggestionFrom', { name: nameOf(reply.author) })}
      </div>
      <div className="bots3-card-text">{reply.text}</div>
      {!open && (
        <div className={`suggestion-status ${reply.status}`} data-testid="suggestion-status">
          {reply.decidedBy
            ? t('bots3.card.statusBy', { status: t(`bots3.card.status.${reply.status}`), name: nameOf(reply.decidedBy) })
            : t(`bots3.card.status.${reply.status}`)}
          {reply.reason && <span className="suggestion-reason">: {reply.reason}</span>}
        </div>
      )}
      <div className="bots3-actions">
        <button type="button" className={`bots3-vote up ${myVote === 1 ? 'on' : ''}`} aria-pressed={myVote === 1} disabled={!open}
          aria-label={t('bots3.card.voteUp', { count: counts.up })} onClick={() => void vote(1)}>👍 <span>{counts.up}</span></button>
        <button type="button" className={`bots3-vote down ${myVote === -1 ? 'on' : ''}`} aria-pressed={myVote === -1} disabled={!open}
          aria-label={t('bots3.card.voteDown', { count: counts.down })} onClick={() => void vote(-1)}>👎 <span>{counts.down}</span></button>
        {staff && (
          <button type="button" className="link" aria-expanded={deciding} onClick={() => setDeciding(!deciding)}>{t('bots3.card.decide')}</button>
        )}
        {staff && reply.anonymous && author === undefined && (
          <button type="button" className="link" onClick={() => void lookUp()}>{t('bots3.card.whoWrote')}</button>
        )}
      </div>
      {author !== undefined && (
        <p className="muted small">{author ? t('bots3.card.writtenBy', { name: nameOf(author) }) : t('bots3.card.writtenByNobody')}</p>
      )}
      {staff && deciding && (
        <form className="bots3-decide" onSubmit={(e) => void decide(e)} aria-label={t('bots3.card.decideTitle')}>
          <div className="bots3-status-choices" role="radiogroup" aria-label={t('bots3.card.decideTitle')}>
            {STATUSES.map((s) => (
              <label key={s} className={`bots3-status-choice ${status === s ? 'on' : ''}`}>
                <input type="radio" name={`decide-${messageId}`} checked={status === s} onChange={() => setStatus(s)} />
                {t(`bots3.card.status.${s}`)}
              </label>
            ))}
          </div>
          {status !== 'open' && (
            <input type="text" maxLength={MAX_REASON} value={reason} placeholder={t('bots3.card.reason')} aria-label={t('bots3.card.reason')}
              onChange={(e) => setReason(e.target.value)} />
          )}
          <button type="submit" className="button primary small" disabled={busy}>{t('bots3.card.apply')}</button>
        </form>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}

function SuggestPrompt({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setStatus(null)
    try {
      await createSuggestion(server.key, text)
      setText('')
      setOpen(false)
      setStatus({ ok: true, text: t('bots3.card.sent') })
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bots3-card suggest-prompt" data-testid="suggest-prompt">
      <span>{t('bots3.card.promptText')}</span>
      {!open && <button type="button" className="button primary small" onClick={() => { setOpen(true); setStatus(null) }}>{t('bots3.card.suggest')}</button>}
      {open && (
        <form className="bots3-suggest-form" onSubmit={(e) => void send(e)}>
          <textarea rows={3} maxLength={MAX_SUGGESTION} value={text} placeholder={t('bots3.card.suggestPlaceholder')}
            aria-label={t('bots3.card.suggestPlaceholder')} autoFocus onChange={(e) => setText(e.target.value)} />
          <div className="bots3-actions">
            <button type="submit" className="button primary small" disabled={busy || !text.trim()}>{t('bots3.card.send')}</button>
            <button type="button" className="button small" onClick={() => setOpen(false)}>{t('bots3.tags.cancel')}</button>
          </div>
        </form>
      )}
      {status && <p className={status.ok ? 'muted small' : 'error-text'} role={status.ok ? 'status' : 'alert'}>{status.text}</p>}
    </div>
  )
}

function GiveawayCard({ server, reply, messageId }: { server: ServerState; reply: R<'giveaway'>; messageId: number }) {
  const { t, i18n } = useTranslation()
  const mine = useCardsMine((s) => s[server.key])
  const roleOf = useRoleLookup(server.key, server.me)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => wantCard(server.key, messageId), [server.key, messageId])
  useEffect(() => {
    if (reply.status !== 'open') return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [reply.status])

  const open = giveawayOpen(reply, now)
  const entered = !!mine?.entered[messageId]
  const staff = !!mine?.staff.giveaways
  const role = reply.roleId !== null ? roleOf(reply.roleId)?.name ?? '' : null
  const winners = nameList(reply.winnerKeys.map((k) => server.members[k]?.name ?? t('chat.author.formerMember')), i18n.language)

  async function run(action: () => Promise<unknown>) {
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

  return (
    <div className={`bots3-card giveaway-card status-${reply.status}`} data-testid="giveaway-card">
      <div className="bots3-card-head">{t('bots3.card.giveaway')}</div>
      <div className="giveaway-prize">{reply.prize}</div>
      <div className="giveaway-facts muted">
        <span>{t('bots3.card.winners', { count: reply.winners })}</span>
        <span data-testid="giveaway-entrants">{t('bots3.card.entrants', { count: reply.entrants })}</span>
        {reply.status === 'open' && <span>{t('bots3.card.ends', { when: whenText(reply.endsAt) })}</span>}
        {reply.status === 'ended' && reply.endedAt && <span>{t('bots3.card.ended', { when: whenText(reply.endedAt) })}</span>}
        {reply.status === 'cancelled' && <span>{t('bots3.card.cancelled')}</span>}
      </div>
      {role !== null && <div className="giveaway-role muted small">{t('bots3.card.roleNeeded', { role })}</div>}
      {reply.status === 'ended' && (
        <div className="giveaway-winners" data-testid="giveaway-winners">
          {reply.winnerKeys.length > 0 ? t('bots3.card.wonBy', { names: winners }) : t('bots3.card.noWinner')}
        </div>
      )}
      <div className="bots3-actions">
        {open && (
          <button type="button" className={`button small ${entered ? '' : 'primary'}`} aria-pressed={entered} disabled={busy}
            onClick={() => void run(() => enterGiveaway(server.key, messageId, !entered))}>
            {entered ? t('bots3.card.leave') : t('bots3.card.enter')}
          </button>
        )}
        {open && entered && <span className="muted small">{t('bots3.card.youreIn')}</span>}
        {staff && reply.status === 'open' && (
          <>
            <button type="button" className="link" disabled={busy} onClick={() => void run(() => giveawayAction(server.key, messageId, 'end'))}>{t('bots3.card.endNow')}</button>
            <button type="button" className="link danger" disabled={busy}
              onClick={() => window.confirm(t('bots3.card.cancelConfirm')) && void run(() => giveawayAction(server.key, messageId, 'cancel'))}>{t('bots3.card.cancel')}</button>
          </>
        )}
        {staff && reply.status === 'ended' && (
          <button type="button" className="link" disabled={busy} onClick={() => void run(() => giveawayAction(server.key, messageId, 'reroll'))}>{t('bots3.card.reroll')}</button>
        )}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}
