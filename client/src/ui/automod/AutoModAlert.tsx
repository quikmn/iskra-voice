// An AutoMod alert in a channel: who was blocked, where, by which rule; the masked text stays hidden until clicked.
import { Trans, useTranslation } from 'react-i18next'
import type { AutoModAlert as Alert } from '../../core/protocol'
import { ruleLabel } from '../../state/automod'
import { durationLabel } from '../../state/moderationRules'
import { openProfileCard } from '../../state/profile'
import type { ServerState } from '../../state/store'
import { Spoiler } from '../bits'
import './automod.css'

const WHAT = ['message', 'edit', 'poll', 'post', 'thread', 'event', 'watch'] as const

export function AutoModAlertCard({ server, alert }: { server: ServerState; alert: Alert }) {
  const { t } = useTranslation()
  const member = server.members[alert.member]
  const name = member?.name ?? alert.memberName
  const channel = alert.channelId !== null ? server.channels.find((c) => c.id === alert.channelId) : undefined
  const where = channel ? `#${channel.name}` : alert.channelName ? `#${alert.channelName}` : null
  const timeout = alert.timeoutMs > 0 ? durationLabel(alert.timeoutMs) : null
  const what = t(`automod.alert.what.${WHAT.find((w) => w === alert.what) ?? 'message'}`)
  const key = where ? (timeout ? 'automod.alert.inTimeout' : 'automod.alert.in') : timeout ? 'automod.alert.privateTimeout' : 'automod.alert.private'
  return (
    <div className="automod-alert" data-testid="automod-alert">
      <div className="automod-alert-line">
        <span className="automod-alert-rule">{ruleLabel(alert.rule)}</span>
        <span>
          <Trans
            i18nKey={key}
            values={{ what, name, where: where ?? '', duration: timeout ?? '' }}
            tOptions={{ interpolation: { escapeValue: true } }}
            shouldUnescape // names are text, never markup
            components={{
              name: member ? <button className="link" onClick={(e) => openProfileCard(server.key, alert.member, e.currentTarget)} /> : <strong />,
            }}
          />
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
