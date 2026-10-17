// A Feeds post: a new blog post, YouTube video or Twitch stream, worded in the app's language (an admin's own post
// text is shown as written). Everything from the feed is rendered as text; the link preview below comes from the
// message's own link, by the app's usual rules.
import { useTranslation } from 'react-i18next'
import type { FeedReply } from '../../core/protocol'
import { mentionToken, postKey, safeUrl } from '../../state/feedsLogic'
import { useRoleLookup } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { renderMarkdown } from '../markdown'
import '../feeds.css'

export function FeedPost({ server, reply }: { server: ServerState; reply: FeedReply }) {
  const { t } = useTranslation()
  const roleOf = useRoleLookup(server.key, server.me)
  const markdown = (text: string) =>
    renderMarkdown(text, { nameOf: (k) => server.members[k]?.name ?? null, me: server.me?.accountKey, roleOf, serverKey: server.key })
  if (reply.text !== null) return <div className="message-text builtin-reply feed-post" data-testid="feed-post">{markdown(reply.text)}</div>
  const token = mentionToken(reply.mention, reply.mentionRoleId)
  const url = safeUrl(reply.url)
  return (
    <div className={`message-text builtin-reply feed-post feed-${reply.source}`} data-testid="feed-post">
      <span className="feed-post-line">
        {token && <>{markdown(token)} </>}
        <span>{t(postKey(reply) as never, { name: reply.name })}</span>{' '}
        <strong className="feed-post-title">{reply.title}</strong>
      </span>
      {url && <a className="feed-post-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>}
    </div>
  )
}
