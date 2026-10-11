// How bots and webhooks look in chat: the BOT badge, webhook avatars and embed cards.
import { useTranslation } from 'react-i18next'
import type { Embed } from '../../core/protocol'
import { fileUrl, type ServerState } from '../../state/store'
import { Avatar } from '../bits'
import { fullTime } from '../format'
import { renderMarkdown } from '../markdown'
import type { AuthorInfo } from './bots'
import { embedColor, safeUrl } from './bots'
import '../bots.css'

export function BotBadge() {
  const { t } = useTranslation()
  return <span className="bot-badge" title={t('chat.bot.title')}>{t('chat.bot.badge')}</span>
}

/** The member avatar, or a webhook's own image. */
export function AuthorAvatar({ server, author, hueKey, size }: { server: ServerState; author: AuthorInfo; hueKey: string; size?: number }) {
  if (author.avatar) {
    return <img className="avatar avatar-image" src={fileUrl(server.key, author.avatar)} alt="" width={size ?? 40} height={size ?? 40} />
  }
  return <Avatar name={author.name} accountKey={hueKey} size={size} />
}

export function Embeds({ server, embeds }: { server: ServerState; embeds: Embed[] }) {
  useTranslation() // dates follow the language
  if (embeds.length === 0) return null
  const ctx = { nameOf: (k: string) => server.members[k]?.name ?? null, me: server.me?.accountKey }
  return (
    <div className="embeds">
      {embeds.map((embed, i) => {
        const url = safeUrl(embed.url)
        const authorUrl = safeUrl(embed.author?.url)
        const color = embedColor(embed.color)
        return (
          <article key={i} className="embed" style={color ? { borderLeftColor: color } : undefined}>
            {embed.author && (
              <div className="embed-author">
                {authorUrl ? <a href={authorUrl} target="_blank" rel="noopener noreferrer">{embed.author.name}</a> : embed.author.name}
              </div>
            )}
            {embed.title && (
              <div className="embed-title">
                {url ? <a href={url} target="_blank" rel="noopener noreferrer">{embed.title}</a> : embed.title}
              </div>
            )}
            {embed.description && <div className="embed-description">{renderMarkdown(embed.description, ctx)}</div>}
            {embed.fields && embed.fields.length > 0 && (
              <div className="embed-fields">
                {embed.fields.map((field, j) => (
                  <div key={j} className={`embed-field ${field.inline ? 'inline' : ''}`}>
                    {field.name && <div className="embed-field-name">{field.name}</div>}
                    {field.value && <div className="embed-field-value">{renderMarkdown(field.value, ctx)}</div>}
                  </div>
                ))}
              </div>
            )}
            {(embed.footer || embed.timestamp) && (
              <div className="embed-footer">
                {embed.footer?.text}
                {embed.footer && embed.timestamp ? ' · ' : ''}
                {embed.timestamp ? fullTime(embed.timestamp) : ''}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}
