// What Starboard, Birthdays and Welcome post, worded in the app's language: the starboard card (with a link back to
// the starred message), birthday greetings and answers, and welcomes (an admin's own text is shown as written).
import { useTranslation } from 'react-i18next'
import type { BuiltinReply, MoreBuiltinReply as Reply } from '../../core/protocol'
import { jumpToMessage } from '../../state/jump'
import { birthdayLabel, nameList } from '../../state/moreBuiltinBotsLogic'
import type { ServerState } from '../../state/store'
import { useEmojiLookup } from '../expressions/useEmojiLookup'
import { renderMarkdown } from '../markdown'
import '../bots.css'
import '../moreBots.css'

const MORE_KINDS = new Set(['star', 'birthday', 'birthday.set', 'birthday.removed', 'birthday.list', 'birthday.usage', 'welcome', 'welcome.batch', 'welcome.private'])

export function isMoreReply(reply: BuiltinReply): reply is BuiltinReply & Reply {
  return MORE_KINDS.has(reply.kind)
}

export function MoreBuiltinReply({ server, reply }: { server: ServerState; reply: BuiltinReply & Reply }) {
  const { t, i18n } = useTranslation()
  const emoji = useEmojiLookup(server.key)
  const locale = i18n.language
  const nameOf = (key: string) => server.members[key]?.name ?? null
  const someone = t('chat.author.formerMember')
  const markdown = (text: string) => renderMarkdown(text, { nameOf, me: server.me?.accountKey, emoji, serverKey: server.key })

  switch (reply.kind) {
    case 'star': {
      const author = nameOf(reply.for) ?? someone
      return (
        <div className="starboard-card" data-testid="starboard-card">
          <div className="starboard-head">
            <span className="starboard-count">{reply.emoji.startsWith('<:') ? markdown(reply.emoji) : reply.emoji} <strong>{reply.count}</strong></span>
            <span className="starboard-where">{t('moreBots.reply.star', { name: author, channel: reply.channelName })}</span>
          </div>
          {reply.excerpt && <div className="starboard-excerpt">{markdown(reply.excerpt)}</div>}
          {reply.image && (
            <img className="starboard-image" src={(server.url ?? '') + reply.image.url} alt="" loading="lazy"
              width={reply.image.width ?? undefined} height={reply.image.height ?? undefined} />
          )}
          <button className="link starboard-jump" onClick={() => void jumpToMessage(server.key, reply.channelId, reply.messageId)}>
            {t('moreBots.reply.jump')}
          </button>
        </div>
      )
    }
    case 'birthday':
      return <div className="message-text builtin-reply birthday-greeting">{t('moreBots.reply.birthday', { names: nameList(reply.people.map((k) => nameOf(k) ?? someone), locale) })}</div>
    case 'birthday.set':
      return <div className="message-text builtin-reply">{t('moreBots.reply.birthdaySet', { date: birthdayLabel(reply.month, reply.day, locale) })}</div>
    case 'birthday.removed':
      return <div className="message-text builtin-reply">{t('moreBots.reply.birthdayRemoved')}</div>
    case 'birthday.usage':
      return <div className="message-text builtin-reply">{t('moreBots.reply.birthdayUsage')}</div>
    case 'birthday.list':
      if (reply.upcoming.length === 0) return <div className="message-text builtin-reply">{t('moreBots.reply.birthdayListNone')}</div>
      return (
        <div className="message-text builtin-reply">
          {t('moreBots.reply.birthdayList')}
          <ul className="birthday-list">
            {reply.upcoming.map((u) => <li key={u.accountKey}><strong>{nameOf(u.accountKey) ?? someone}</strong> · {birthdayLabel(u.month, u.day, locale)}</li>)}
          </ul>
        </div>
      )
    case 'welcome':
      return (
        <div className="message-text builtin-reply welcome-post">
          {reply.text !== null ? markdown(reply.text) : t('moreBots.reply.welcome', { server: server.name, name: nameOf(reply.for) ?? someone })}
        </div>
      )
    case 'welcome.batch': {
      const names = reply.people.map((k) => nameOf(k) ?? someone)
      const more = reply.count - names.length
      if (more > 0) names.push(t('moreBots.reply.more', { count: more }))
      return <div className="message-text builtin-reply welcome-post">{t('moreBots.reply.welcomeBatch', { count: reply.count, names: nameList(names, locale) })}</div>
    }
    case 'welcome.private':
      return <div className="message-text builtin-reply welcome-post">{markdown(reply.text)}</div>
  }
}
