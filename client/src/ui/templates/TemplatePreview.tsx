// Create a server → the template step: everything the picked template sets up, before anything is created.
import { useTranslation } from 'react-i18next'
import type { ServerTemplateInfo, TemplateChannelInfo } from '../../platform/desktop'
import { channelNotes } from '../../state/templates'
import { levelName, permissionLabel } from '../../state/permissions'
import type { Permission } from '../../core/protocol'
import { ChannelKindIcon } from '../ChannelKindIcon'
import './templates.css'

function ChannelRow({ channel }: { channel: TemplateChannelInfo }) {
  const notes = channelNotes(channel)
  return (
    <li>
      <ChannelKindIcon kind={channel.kind} size={13} />
      <span className="template-channel-name">{channel.name}</span>
      {notes.length > 0 && <small className="muted">{notes.join(' · ')}</small>}
    </li>
  )
}

export function TemplatePreview({ template }: { template: ServerTemplateInfo }) {
  const { t } = useTranslation()
  const groups = [...(template.channels.length > 0 ? [{ name: null as string | null, channels: template.channels }] : []), ...template.categories]
  const roles = template.roleDetails ?? template.roles.map((name) => ({ name, color: null, icon: null, permissions: [] as string[] }))
  const builtin = Object.entries(template.builtinRoles ?? {}).filter(([, b]) => b.abilities || b.permissions)
  const s = template.settings
  const settings = [
    ...(s?.notifyDefault ? [t('templates.preview.notifyDefault', {
      level: s.notifyDefault === 'auto' ? t('templates.preview.notifyAuto') : t(`organize.levels.${s.notifyDefault as 'all'}`),
    })] : []),
    ...(s?.builtinBots.length ? [t('templates.preview.bots', { bots: s.builtinBots.join(', ') })] : []),
    ...(s?.limits ? [t('templates.preview.limits')] : []),
    ...(s?.bugInbox ? [t('templates.preview.bugInbox', { channel: s.bugInbox })] : []),
    ...(template.afk ? [t('templates.preview.afk', { channel: template.afk.channel, minutes: template.afk.minutes })] : []),
    ...(template.rules ? [t('templates.preview.rules')] : []),
  ]
  return (
    <section className="template-details" aria-label={t('templates.preview.title')} data-testid="template-details">
      <h3 className="h4">{t('templates.preview.title')}</h3>
      <h4>{t('templates.preview.channels')}</h4>
      {groups.map((group, i) => (
        <div key={i} className="template-details-group">
          {group.name && <span className="template-category">{group.name}</span>}
          <ul>{group.channels.map((c, j) => <ChannelRow key={j} channel={c} />)}</ul>
        </div>
      ))}
      {roles.length > 0 && (
        <>
          <h4>{t('templates.preview.roles')}</h4>
          <ul className="template-details-roles">
            {roles.map((r) => (
              <li key={r.name}>
                <span className="role-dot" style={{ background: r.color ?? 'var(--muted)' }} aria-hidden />
                <span>{r.icon ? `${r.icon} ` : ''}{r.name}</span>
                <small className="muted">
                  {r.permissions.length > 0 ? r.permissions.map((p) => permissionLabel(p as Permission)).join(', ') : t('templates.preview.noPermissions')}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
      {builtin.length > 0 && (
        <>
          <h4>{t('templates.preview.builtinRoles')}</h4>
          <ul className="template-details-roles">
            {builtin.map(([role]) => <li key={role}>{t('templates.preview.builtinChanged', { role: levelName(role) })}</li>)}
          </ul>
        </>
      )}
      {settings.length > 0 && (
        <>
          <h4>{t('templates.preview.settings')}</h4>
          <ul className="template-details-settings">{settings.map((line) => <li key={line}>{line}</li>)}</ul>
        </>
      )}
    </section>
  )
}
