// An AutoMod alert in a channel: who was blocked, where, by which rule; the masked text stays hidden until clicked.
import type { AutoModAlert as Alert } from '../../core/protocol'
import { RULE_LABELS } from '../../state/automod'
import { TIMEOUT_OPTIONS } from '../../state/moderationRules'
import { openProfileCard } from '../../state/profile'
import type { ServerState } from '../../state/store'
import { Spoiler } from '../bits'
import './automod.css'

const WHAT: Record<Alert['what'], string> = {
  message: 'a message', edit: 'an edit', poll: 'a poll', post: 'a forum post', thread: 'a thread name', event: 'an event', watch: 'a watch party message',
}

export function AutoModAlertCard({ server, alert }: { server: ServerState; alert: Alert }) {
  const member = server.members[alert.member]
  const name = member?.name ?? alert.memberName
  const channel = alert.channelId !== null ? server.channels.find((c) => c.id === alert.channelId) : undefined
  const where = channel ? `#${channel.name}` : alert.channelName ? `#${alert.channelName}` : null
  const timeout = alert.timeoutMs > 0 ? TIMEOUT_OPTIONS.find((o) => o.ms === alert.timeoutMs)?.label ?? `${Math.round(alert.timeoutMs / 60_000)} minutes` : null
  return (
    <div className="automod-alert" data-testid="automod-alert">
      <div className="automod-alert-line">
        <span className="automod-alert-rule">{RULE_LABELS[alert.rule] ?? alert.rule}</span>
        <span>
          Blocked {WHAT[alert.what] ?? 'a message'} from{' '}
          {member ? <button className="link" onClick={(e) => openProfileCard(server.key, alert.member, e.currentTarget)}>{name}</button> : <strong>{name}</strong>}
          {where ? ` in ${where}` : ' in a private channel'}
          {timeout ? ` and timed them out for ${timeout}` : ''}.
        </span>
      </div>
      {alert.snippet && (
        <div className="automod-alert-snippet">
          <Spoiler>{alert.snippet}</Spoiler>
        </div>
      )}
    </div>
  )
}
