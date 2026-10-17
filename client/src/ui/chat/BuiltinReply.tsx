// A built-in bot's answer (Dice, Polls, Reminders), worded in the app's language from what it means; dice show each roll.
import { useTranslation } from 'react-i18next'
import type { BuiltinReply as Reply } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { replyLine, rollTerms } from '../../state/builtinBotsLogic'
import { errorMessage } from '../../i18n/errors'
import { whenText } from '../productivity/WhenPicker'
import { isMoreReply, MoreBuiltinReply } from './MoreBuiltinReply'
import { FeedPost, isFeedReply } from './FeedPost'
import '../bots.css'

export function BuiltinReply({ server, reply }: { server: ServerState; reply: Reply }) {
  if (isMoreReply(reply)) return <MoreBuiltinReply server={server} reply={reply} />
  if (isFeedReply(reply)) return <FeedPost server={server} reply={reply} />
  return <ClassicReply server={server} reply={reply} />
}

function ClassicReply({ server, reply }: { server: ServerState; reply: Reply }) {
  const { t } = useTranslation()
  const name = server.members[reply.for]?.name ?? t('chat.author.formerMember')
  const line = replyLine(reply, name, (key, args) => String(t(key as never, args as never)), whenText, errorMessage)
  if (reply.kind !== 'roll') return <div className="message-text builtin-reply">{line}</div>
  const terms = rollTerms(reply)
  return (
    <div className="message-text builtin-reply builtin-roll">
      <span>{line}</span>
      <span className="dice-line">
        {terms.map((term, i) => (
          <span key={i} className="dice-term">
            {term.op && <span className="dice-op" aria-hidden>{term.op === '-' ? '−' : '+'}</span>}
            {term.dice ? (
              <span className="dice-group" title={term.label}>
                {term.dice.map((die, j) => <span key={j} className={`die ${die.edge ?? ''}`}>{die.value}</span>)}
              </span>
            ) : <span className="dice-modifier">{term.label}</span>}
          </span>
        ))}
        <span className="dice-op" aria-hidden>=</span>
        <strong className="dice-total" aria-label={`${t('builtinBots.reply.total')}: ${reply.total}`}>{reply.total}</strong>
      </span>
    </div>
  )
}
