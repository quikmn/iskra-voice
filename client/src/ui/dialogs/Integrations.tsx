// Settings → Bots & webhooks (admins): incoming webhooks (secret URLs that post into a channel) and bot invites.
import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { buildInviteLink } from '../../core/invite'
import { roleRank, type Role, type Webhook } from '../../core/protocol'
import { connectionFor, uploadFile, type ServerState } from '../../state/store'
import { inviteServerUrl } from '../../state/hosting'
import { Avatar, Spinner } from '../bits'
import { AuthorAvatar, BotBadge } from '../chat/BotBits'
import { appUrl, messageTime } from '../format'
import '../bots.css'
import { OutgoingWebhooks } from './OutgoingWebhooks'

type Tab = 'webhooks' | 'outgoing' | 'bots'

/** Settings → Bots & webhooks (admins). */
export function IntegrationsSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('webhooks')
  return (
    <section className="settings-section integrations">
      <h2>{t('settings.sections.integrations')}</h2>
      <div className="segmented" role="tablist" aria-label={t('settings.integrations.tabs')}>
        <button role="tab" aria-selected={tab === 'webhooks'} className={tab === 'webhooks' ? 'on' : ''} onClick={() => setTab('webhooks')}>{t('settings.integrations.webhooks')}</button>
        <button role="tab" aria-selected={tab === 'outgoing'} className={tab === 'outgoing' ? 'on' : ''} onClick={() => setTab('outgoing')}>{t('outhooks.tab')}</button>
        <button role="tab" aria-selected={tab === 'bots'} className={tab === 'bots' ? 'on' : ''} onClick={() => setTab('bots')}>{t('settings.integrations.bots')}</button>
      </div>
      {tab === 'webhooks' ? <Webhooks server={server} /> : tab === 'outgoing' ? <OutgoingWebhooks server={server} /> : <Bots server={server} />}
    </section>
  )
}

/** A freshly made secret URL: shown once, then only its hash is kept on the server. */
function SecretUrl({ url, onDone }: { url: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="secret-box" role="status">
      <p>{t('settings.integrations.copyNow')}</p>
      <div className="copy-row">
        <input readOnly value={url} aria-label={t('settings.integrations.webhookUrl')} onFocus={(e) => e.target.select()} />
        <button className="button primary" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
          {copied ? t('settings.recovery.copied') : t('common.copy')}
        </button>
        <button className="button" onClick={onDone}>{t('common.done')}</button>
      </div>
      <pre>{`curl -H "Content-Type: application/json" -d '{"content":"Hello from a webhook"}' \\\n  ${url}`}</pre>
    </div>
  )
}

function Webhooks({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const connection = connectionFor(server.key)
  const textChannels = server.channels.filter((c) => c.kind === 'text')
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secretUrl, setSecretUrl] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const reload = useCallback(() => {
    connection?.request('webhook.list', {}).then((r) => setHooks(r.webhooks)).catch((e: Error) => setError(errorMessage(e)))
  }, [connection])
  useEffect(reload, [reload])

  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      setError(null)
      reload()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const channelName = (id: number) => server.channels.find((c) => c.id === id)?.name ?? t('settings.integrations.unknownChannel')

  return (
    <>
      <p className="muted">{t('settings.integrations.webhooksIntro')}</p>
      {secretUrl && <SecretUrl url={secretUrl} onDone={() => setSecretUrl(null)} />}
      {hooks === null ? <Spinner /> : hooks.length > 0 && (
        <ul className="hook-list">
          {hooks.map((hook) => (
            <li key={hook.id} className="hook">
              <AuthorAvatar server={server} author={{ name: hook.name, bot: true, avatar: hook.avatar }} hueKey={`webhook:${hook.id}`} size={36} />
              <span className="hook-name">{hook.name}</span>
              <span className="hook-meta">
                #{channelName(hook.channelId)} · {hook.lastUsedAt ? t('settings.integrations.lastUsed', { when: messageTime(hook.lastUsedAt) }) : t('settings.integrations.notUsed')}
                {hook.mentions ? ` · ${t('settings.integrations.canMention')}` : ''}
              </span>
              {editing === hook.id ? (
                <div className="hook-actions">
                  <WebhookForm
                    server={server}
                    initial={hook}
                    submitLabel={t('common.save')}
                    onCancel={() => setEditing(null)}
                    onSubmit={(values) => run(async () => {
                      await connection!.request('webhook.update', { id: hook.id, ...values })
                      setEditing(null)
                    })}
                  />
                </div>
              ) : confirmDelete === hook.id ? (
                <div className="hook-actions">
                  <span>{t('settings.integrations.deleteConfirm', { name: hook.name })}</span>
                  <button className="button danger" onClick={() => void run(() => connection!.request('webhook.delete', { id: hook.id }))}>{t('common.delete')}</button>
                  <button className="button" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <div className="hook-actions">
                  <button className="button" onClick={() => setEditing(hook.id)}>{t('common.edit')}</button>
                  <button
                    className="button"
                    title={t('settings.integrations.newUrlHint')}
                    onClick={() => void run(async () => {
                      const r = await connection!.request('webhook.regenerate', { id: hook.id })
                      setSecretUrl(inviteServerUrl(server) + r.path)
                    })}
                  >
                    {t('settings.integrations.newUrl')}
                  </button>
                  <button className="button danger-outline" onClick={() => setConfirmDelete(hook.id)}>{t('common.delete')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {textChannels.length > 0 && editing === null && (
        <section className="settings-section">
          <h3>{t('settings.integrations.newWebhook')}</h3>
          <WebhookForm
            server={server}
            submitLabel={t('settings.integrations.createWebhook')}
            onSubmit={(values) => run(async () => {
              const r = await connection!.request('webhook.create', values)
              setSecretUrl(inviteServerUrl(server) + r.path)
            })}
          />
        </section>
      )}
      {error && <p className="error-text">{error}</p>}
    </>
  )
}

interface WebhookValues {
  name: string
  channelId: number
  mentions: boolean
  avatar?: string
}

function WebhookForm({ server, initial, submitLabel, onSubmit, onCancel }: {
  server: ServerState
  initial?: Webhook
  submitLabel: string
  onSubmit: (values: WebhookValues) => Promise<void>
  onCancel?: () => void
}) {
  const { t } = useTranslation()
  const textChannels = server.channels.filter((c) => c.kind === 'text')
  const [name, setName] = useState(initial?.name ?? '')
  const [channelId, setChannelId] = useState(initial?.channelId ?? textChannels[0]?.id)
  const [mentions, setMentions] = useState(initial?.mentions ?? false)
  const [avatar, setAvatar] = useState<File | null>(null)
  const [clearAvatar, setClearAvatar] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim() || busy || channelId === undefined) return
    setBusy(true)
    try {
      let avatarId: string | undefined = clearAvatar ? '' : undefined
      if (avatar) avatarId = (await uploadFile(server.key, avatar, () => undefined)).id
      await onSubmit({ name: name.trim(), channelId, mentions, avatar: avatarId })
      if (!initial) {
        setName('')
        setAvatar(null)
        setMentions(false)
      }
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ width: '100%' }}>
      <label className="field">
        <span>{t('settings.overview.name')}</span>
        <input value={name} maxLength={32} placeholder="GitHub" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </label>
      <div className="options-row" style={{ marginTop: 0 }}>
        <label className="field inline">
          <span>{t('settings.integrations.postsIn')}</span>
          <select value={channelId} onChange={(e) => setChannelId(Number(e.target.value))}>
            {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>{t('settings.integrations.picture')}</span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setAvatar(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      {initial?.avatar && !avatar && (
        <label className="checkbox">
          <input type="checkbox" checked={clearAvatar} onChange={(e) => setClearAvatar(e.target.checked)} />
          {t('settings.integrations.removePicture')}
        </label>
      )}
      <label className="checkbox" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={mentions} onChange={(e) => setMentions(e.target.checked)} />
        {t('settings.integrations.mentions')}
      </label>
      <div className="copy-row">
        <button className="button primary" disabled={!name.trim() || busy} onClick={() => void submit()}>{busy ? <Spinner /> : submitLabel}</button>
        {onCancel && <button className="button" onClick={onCancel}>{t('common.cancel')}</button>}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

function Bots({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const connection = connectionFor(server.key)
  const me = server.me
  const [role, setRole] = useState<Role>('member')
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const bots = Object.values(server.members).filter((m) => m.bot).sort((a, b) => a.name.localeCompare(b.name))

  async function createInvite() {
    try {
      const { invite } = await connection!.request('bot.invite', { role })
      setLink(buildInviteLink(appUrl(server.appUrl), { serverUrl: server.url, serverKey: server.key, code: invite.code }))
      setCopied(false)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function remove(accountKey: string) {
    try {
      await connection!.request('member.kick', { accountKey })
      setConfirmRemove(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <p className="muted">
        <Trans i18nKey="settings.integrations.botsIntro" components={{ code: <code />, badge: <BotBadge /> }} />
      </p>
      <div className="options-row" style={{ marginTop: 0 }}>
        <label className="field inline">
          <span>{t('settings.integrations.botRole')}</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {(['guest', 'member', 'trusted'] as Role[]).map((r) => <option key={r} value={r}>{t(`common.roles.${r}`)}</option>)}
          </select>
        </label>
        <button className="button primary" onClick={() => void createInvite()}>{t('settings.integrations.createBotInvite')}</button>
      </div>
      {link && (
        <div className="secret-box" style={{ marginTop: 12 }}>
          <p>{t('settings.integrations.botInviteHint')}</p>
          <div className="copy-row">
            <input readOnly value={link} aria-label={t('settings.integrations.botInviteLink')} onFocus={(e) => e.target.select()} />
            <button className="button primary" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
              {copied ? t('settings.recovery.copied') : t('common.copy')}
            </button>
          </div>
          <pre>{`cd bots && npm install\nISKRA_INVITE='${link}' npm run dice\n\n# PowerShell\n$env:ISKRA_INVITE='${link}'; npm run dice`}</pre>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <section className="settings-section">
        <h3>{t('settings.integrations.botsHere', { n: bots.length })}</h3>
        {bots.length === 0 && <p className="muted">{t('settings.integrations.noBots')}</p>}
        {bots.map((bot) => (
          <div key={bot.accountKey} className="bot-row">
            <Avatar name={bot.name} accountKey={bot.accountKey} size={32} online={bot.online} />
            <span className="member-name">{bot.name} <BotBadge /></span>
            {me && roleRank(me.role) > roleRank(bot.role) && (confirmRemove === bot.accountKey ? (
              <>
                <button className="button danger" onClick={() => void remove(bot.accountKey)}>{t('common.remove')}</button>
                <button className="button" onClick={() => setConfirmRemove(null)}>{t('common.cancel')}</button>
              </>
            ) : (
              <button className="button danger-outline" onClick={() => setConfirmRemove(bot.accountKey)}>{t('common.remove')}</button>
            ))}
          </div>
        ))}
      </section>
    </>
  )
}
