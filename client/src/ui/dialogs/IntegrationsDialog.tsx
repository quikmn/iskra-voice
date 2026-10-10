// Admins: incoming webhooks (secret URLs that post into a channel) and bot invites.
import { useCallback, useEffect, useState } from 'react'
import { buildInviteLink } from '../../core/invite'
import { roleRank, type Role, type Webhook } from '../../core/protocol'
import { connectionFor, uploadFile, type ServerState } from '../../state/store'
import { Avatar, Modal, Spinner } from '../bits'
import { AuthorAvatar, BotBadge } from '../chat/BotBits'
import { appUrl, messageTime } from '../format'
import '../bots.css'

type Tab = 'webhooks' | 'bots'

export function IntegrationsDialog({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('webhooks')
  return (
    <Modal title="Integrations" onClose={onClose}>
      <div className="integrations">
        <div className="segmented" role="tablist" aria-label="Integrations">
          <button role="tab" aria-selected={tab === 'webhooks'} className={tab === 'webhooks' ? 'on' : ''} onClick={() => setTab('webhooks')}>Webhooks</button>
          <button role="tab" aria-selected={tab === 'bots'} className={tab === 'bots' ? 'on' : ''} onClick={() => setTab('bots')}>Bots</button>
        </div>
        {tab === 'webhooks' ? <Webhooks server={server} /> : <Bots server={server} />}
      </div>
    </Modal>
  )
}

/** A freshly made secret URL: shown once, then only its hash is kept on the server. */
function SecretUrl({ url, onDone }: { url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="secret-box" role="status">
      <p>Copy this URL now. For safety it won't be shown again.</p>
      <div className="copy-row">
        <input readOnly value={url} aria-label="Webhook URL" onFocus={(e) => e.target.select()} />
        <button className="button primary" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button className="button" onClick={onDone}>Done</button>
      </div>
      <pre>{`curl -H "Content-Type: application/json" -d '{"content":"Hello from a webhook"}' \\\n  ${url}`}</pre>
    </div>
  )
}

function Webhooks({ server }: { server: ServerState }) {
  const connection = connectionFor(server.key)
  const textChannels = server.channels.filter((c) => c.kind === 'text')
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secretUrl, setSecretUrl] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const reload = useCallback(() => {
    connection?.request('webhook.list', {}).then((r) => setHooks(r.webhooks)).catch((e: Error) => setError(e.message))
  }, [connection])
  useEffect(reload, [reload])

  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      setError(null)
      reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const channelName = (id: number) => server.channels.find((c) => c.id === id)?.name ?? 'unknown'

  return (
    <>
      <p className="muted">
        A webhook is a secret link that lets another app post into a channel, like build results, alerts or game stats.
        Tools made for Discord webhooks usually work as they are.
      </p>
      {secretUrl && <SecretUrl url={secretUrl} onDone={() => setSecretUrl(null)} />}
      {hooks === null ? <Spinner /> : hooks.length > 0 && (
        <ul className="hook-list">
          {hooks.map((hook) => (
            <li key={hook.id} className="hook">
              <AuthorAvatar server={server} author={{ name: hook.name, bot: true, avatar: hook.avatar }} hueKey={`webhook:${hook.id}`} size={36} />
              <span className="hook-name">{hook.name}</span>
              <span className="hook-meta">
                #{channelName(hook.channelId)} · {hook.lastUsedAt ? `last used ${messageTime(hook.lastUsedAt)}` : 'not used yet'}
                {hook.mentions ? ' · can mention' : ''}
              </span>
              {editing === hook.id ? (
                <div className="hook-actions">
                  <WebhookForm
                    server={server}
                    initial={hook}
                    submitLabel="Save"
                    onCancel={() => setEditing(null)}
                    onSubmit={(values) => run(async () => {
                      await connection!.request('webhook.update', { id: hook.id, ...values })
                      setEditing(null)
                    })}
                  />
                </div>
              ) : confirmDelete === hook.id ? (
                <div className="hook-actions">
                  <span>Delete {hook.name}? Apps using it will stop posting.</span>
                  <button className="button danger" onClick={() => void run(() => connection!.request('webhook.delete', { id: hook.id }))}>Delete</button>
                  <button className="button" onClick={() => setConfirmDelete(null)}>Cancel</button>
                </div>
              ) : (
                <div className="hook-actions">
                  <button className="button" onClick={() => setEditing(hook.id)}>Edit</button>
                  <button
                    className="button"
                    title="Makes a new URL; the old one stops working"
                    onClick={() => void run(async () => {
                      const r = await connection!.request('webhook.regenerate', { id: hook.id })
                      setSecretUrl(server.url + r.path)
                    })}
                  >
                    New URL
                  </button>
                  <button className="button danger-outline" onClick={() => setConfirmDelete(hook.id)}>Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {textChannels.length > 0 && editing === null && (
        <section className="settings-section">
          <h3>New webhook</h3>
          <WebhookForm
            server={server}
            submitLabel="Create webhook"
            onSubmit={(values) => run(async () => {
              const r = await connection!.request('webhook.create', values)
              setSecretUrl(server.url + r.path)
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
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ width: '100%' }}>
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={32} placeholder="GitHub" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </label>
      <div className="options-row" style={{ marginTop: 0 }}>
        <label className="field inline">
          <span>Posts in</span>
          <select value={channelId} onChange={(e) => setChannelId(Number(e.target.value))}>
            {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>Picture (optional)</span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setAvatar(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      {initial?.avatar && !avatar && (
        <label className="checkbox">
          <input type="checkbox" checked={clearAvatar} onChange={(e) => setClearAvatar(e.target.checked)} />
          Remove picture
        </label>
      )}
      <label className="checkbox" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={mentions} onChange={(e) => setMentions(e.target.checked)} />
        Can mention people (including @everyone)
      </label>
      <div className="copy-row">
        <button className="button primary" disabled={!name.trim() || busy} onClick={() => void submit()}>{busy ? <Spinner /> : submitLabel}</button>
        {onCancel && <button className="button" onClick={onCancel}>Cancel</button>}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

function Bots({ server }: { server: ServerState }) {
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
      setError((e as Error).message)
    }
  }

  async function remove(accountKey: string) {
    try {
      await connection!.request('member.kick', { accountKey })
      setConfirmRemove(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <p className="muted">
        Bots are small programs that join like a person and chat in channels, for example to roll dice or answer <code>/commands</code>.
        They show a <BotBadge /> badge and can't join voice. To add one, make a bot invite and start the bot with it.
      </p>
      <div className="options-row" style={{ marginTop: 0 }}>
        <label className="field inline">
          <span>Bot role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {(['guest', 'member', 'trusted'] as Role[]).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <button className="button primary" onClick={() => void createInvite()}>Create bot invite</button>
      </div>
      {link && (
        <div className="secret-box" style={{ marginTop: 12 }}>
          <p>Single use, valid for 7 days. Only a bot can join with it.</p>
          <div className="copy-row">
            <input readOnly value={link} aria-label="Bot invite link" onFocus={(e) => e.target.select()} />
            <button className="button primary" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <pre>{`cd bots && npm install\nISKRA_INVITE='${link}' npm run dice`}</pre>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <section className="settings-section">
        <h3>Bots on this server — {bots.length}</h3>
        {bots.length === 0 && <p className="muted">No bots yet.</p>}
        {bots.map((bot) => (
          <div key={bot.accountKey} className="bot-row">
            <Avatar name={bot.name} accountKey={bot.accountKey} size={32} online={bot.online} />
            <span className="member-name">{bot.name} <BotBadge /></span>
            {me && roleRank(me.role) > roleRank(bot.role) && (confirmRemove === bot.accountKey ? (
              <>
                <button className="button danger" onClick={() => void remove(bot.accountKey)}>Remove</button>
                <button className="button" onClick={() => setConfirmRemove(null)}>Cancel</button>
              </>
            ) : (
              <button className="button danger-outline" onClick={() => setConfirmRemove(bot.accountKey)}>Remove</button>
            ))}
          </div>
        ))}
      </section>
    </>
  )
}
