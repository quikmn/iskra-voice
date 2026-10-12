// Custom roles: Settings → This server → Roles (create, edit, drag to reorder), role chips on profiles,
// giving roles to a member, channel permissions per role, and voice moderation (mute, move).
import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, ChannelPermission, Member, Permission, ServerRole } from '../../core/protocol'
import {
  createRole, deleteRole, moveToChannel, reorderRoles, serverMute, setMemberRoles, setOverride, updateRole, useServerRoles,
} from '../../state/roles'
import { has, isAbove, isAdmin, MODERATOR_PRESET, outranks, permissionHint, permissionLabel, PERMISSIONS, rolesOf } from '../../state/permissions'
import { errorMessage } from '../../i18n/errors'
import type { ServerState } from '../../state/store'
import './roles.css'

const errorText = errorMessage

// ── Role chips ──────────────────────────────────────────────────────────────

export function RoleChips({ server, member }: { server: ServerState; member: Member }) {
  const { t } = useTranslation()
  const roles = rolesOf(member, useServerRoles(server.key))
  if (roles.length === 0) return null
  return (
    <ul className="role-chips" aria-label={t('roles.chips')}>
      {roles.map((r) => (
        <li key={r.id} className="role-chip-custom">
          <span className="role-dot" style={{ background: r.color ?? 'var(--muted)' }} aria-hidden />
          {r.icon && <span aria-hidden>{r.icon}</span>}
          {r.name}
        </li>
      ))}
    </ul>
  )
}

// ── Settings → Roles ────────────────────────────────────────────────────────

export function RolesSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const me = server.me
  const [selected, setSelected] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const counts = new Map<number, number>()
  for (const m of Object.values(server.members)) for (const id of m.roles ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  const current = roles.find((r) => r.id === selected) ?? null

  async function add() {
    try {
      const role = await createRole(server.key, { name: t('roles.newRole') })
      setSelected(role.id)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function move(id: number, toIndex: number) {
    const ids = roles.map((r) => r.id).filter((x) => x !== id)
    ids.splice(Math.max(0, Math.min(ids.length, toIndex)), 0, id)
    if (ids.every((x, i) => x === roles[i].id)) return
    try {
      await reorderRoles(server.key, ids)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  function onDrop(e: DragEvent, index: number) {
    e.preventDefault()
    if (dragging !== null) void move(dragging, index)
    setDragging(null)
  }

  return (
    <section className="settings-section">
      <h2>{t('roles.title')}</h2>
      <p className="muted">{t('roles.intro')}</p>
      <button className="button primary" onClick={() => void add()}>{t('roles.create')}</button>
      {error && <p className="error-text">{error}</p>}
      {roles.length === 0 ? (
        <p className="empty-note">{t('roles.empty')}</p>
      ) : (
        <ol className="role-list">
          {roles.map((r, i) => {
            const movable = isAbove(me, r.position, roles)
            return (
              <li
                key={r.id}
                className={`role-row ${selected === r.id ? 'selected' : ''} ${dragging === r.id ? 'dragging' : ''}`}
                draggable={movable}
                onDragStart={(e) => { setDragging(r.id); e.dataTransfer.effectAllowed = 'move' }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => movable && e.preventDefault()}
                onDrop={(e) => onDrop(e, i)}
              >
                <span className={`drag-handle ${movable ? '' : 'locked'}`} aria-hidden>⋮⋮</span>
                <button className="role-pick" onClick={() => setSelected(selected === r.id ? null : r.id)} aria-expanded={selected === r.id}>
                  <span className="role-dot" style={{ background: r.color ?? 'var(--muted)' }} aria-hidden />
                  {r.icon && <span aria-hidden>{r.icon}</span>}
                  <span className="role-name">{r.name}</span>
                  <span className="muted">{counts.get(r.id) ?? 0}</span>
                </button>
                {movable && (
                  <span className="role-move">
                    <button className="icon-button small" aria-label={t('roles.moveUp', { name: r.name })} disabled={i === 0 || !isAbove(me, roles[i - 1].position, roles)}
                      onClick={() => void move(r.id, i - 1)}>↑</button>
                    <button className="icon-button small" aria-label={t('roles.moveDown', { name: r.name })} disabled={i === roles.length - 1}
                      onClick={() => void move(r.id, i + 1)}>↓</button>
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {current && <RoleEditor key={current.id} server={server} role={current} onDeleted={() => setSelected(null)} />}
    </section>
  )
}

function RoleEditor({ server, role, onDeleted }: { server: ServerState; role: ServerRole; onDeleted: () => void }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const me = server.me
  const editable = isAbove(me, role.position, roles)
  const [name, setName] = useState(role.name)
  const [color, setColor] = useState(role.color)
  const [icon, setIcon] = useState(role.icon ?? '')
  const [hoist, setHoist] = useState(role.hoist)
  const [mentionable, setMentionable] = useState(!!role.mentionable)
  const [perms, setPerms] = useState<Permission[]>(role.permissions)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // You can only hand out permissions you have (a permission the role already has can stay).
  const grantable = (p: Permission) => isAdmin(me) || has(me, roles, p) || role.permissions.includes(p)

  async function save() {
    try {
      await updateRole(server.key, role.id, { name, color: color ?? '', icon, hoist, mentionable, permissions: perms })
      setError(null)
      setStatus(t('common.saved'))
    } catch (e) {
      setError(errorText(e))
      setStatus(null)
    }
  }

  return (
    <div className="role-editor" aria-label={t('roles.edit', { name: role.name })} role="group">
      <div className="role-editor-fields">
        <label className="field">
          <span>{t('roles.name')}</span>
          <input value={name} maxLength={32} disabled={!editable} aria-label={t('roles.nameLabel')} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field role-icon-field">
          <span>{t('roles.icon')}</span>
          <input value={icon} maxLength={16} placeholder={t('roles.iconPlaceholder')} disabled={!editable} onChange={(e) => setIcon(e.target.value.trim())} aria-label={t('roles.iconLabel')} />
        </label>
        <div className="field">
          <span>{t('roles.colour')}</span>
          <div className="copy-row">
            <input type="color" className="color-input" value={color ?? '#99aab5'} disabled={!editable} aria-label={t('roles.colourLabel')}
              onChange={(e) => setColor(e.target.value)} />
            <button className="button small" disabled={!editable || !color} onClick={() => setColor(null)}>{t('roles.noColour')}</button>
          </div>
        </div>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={hoist} disabled={!editable} onChange={(e) => setHoist(e.target.checked)} />
        {t('roles.hoist')}
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={mentionable} disabled={!editable} onChange={(e) => setMentionable(e.target.checked)} />
        {t('roles.mentionable')}
      </label>
      <div className="role-perms-head">
        <strong>{t('roles.permissionsTitle')}</strong>
        <button className="button small" disabled={!editable} onClick={() => setPerms(MODERATOR_PRESET.filter(grantable))}>{t('roles.moderatorPreset')}</button>
        <button className="button small ghost" disabled={!editable} onClick={() => setPerms([])}>{t('common.clear')}</button>
      </div>
      <ul className="role-perms">
        {PERMISSIONS.map((p) => (
          <li key={p}>
            <label className="checkbox">
              <input
                type="checkbox" checked={perms.includes(p)} disabled={!editable || !grantable(p)}
                onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))}
              />
              <span>
                <span>{permissionLabel(p)}</span>
                <small className="muted">{permissionHint(p)}</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {!editable && <p className="muted">{t('roles.locked')}</p>}
      {error && <p className="error-text">{error}</p>}
      {editable && (
        <div className="copy-row role-editor-actions">
          <button className="button primary" onClick={() => void save()}>{t('roles.save')}</button>
          {status && <span className="muted" role="status">{status}</span>}
          <span className="spacer" />
          {confirmDelete ? (
            <>
              <button className="button danger" onClick={() => void deleteRole(server.key, role.id).then(onDeleted, (e) => setError(errorText(e)))}>{t('common.delete')}</button>
              <button className="button" onClick={() => setConfirmDelete(false)}>{t('roles.keep')}</button>
            </>
          ) : (
            <button className="button danger-outline" onClick={() => setConfirmDelete(true)}>{t('roles.delete')}</button>
          )}
        </div>
      )}
    </div>
  )
}

// ── A member's roles (member dialog) ────────────────────────────────────────

export function MemberRolesEditor({ server, member }: { server: ServerState; member: Member }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const me = server.me
  const [error, setError] = useState<string | null>(null)
  const self = me?.accountKey === member.accountKey
  if (!has(me, roles, 'manageRoles') || roles.length === 0 || (!self && !outranks(me, member, roles))) return null
  const mine = new Set(member.roles ?? [])

  async function toggle(role: ServerRole, on: boolean) {
    const next = on ? [...mine, role.id] : [...mine].filter((id) => id !== role.id)
    try {
      await setMemberRoles(server.key, member.accountKey, next)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="member-roles-editor">
      <strong>{t('roles.memberRoles')}</strong>
      <ul className="role-checks">
        {roles.map((r) => (
          <li key={r.id}>
            <label className="checkbox">
              <input type="checkbox" checked={mine.has(r.id)} disabled={!isAbove(me, r.position, roles)} onChange={(e) => void toggle(r, e.target.checked)} />
              <span className="role-dot" style={{ background: r.color ?? 'var(--muted)' }} aria-hidden />
              {r.icon && <span aria-hidden>{r.icon}</span>}
              {r.name}
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

// ── Voice moderation (member dialog) ────────────────────────────────────────

export function VoiceModControls({ server, member }: { server: ServerState; member: Member }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const me = server.me
  const [error, setError] = useState<string | null>(null)
  const channelId = Object.entries(server.voice).find(([, list]) => list.some((p) => p.accountKey === member.accountKey))?.[0]
  const self = me?.accountKey === member.accountKey
  const canMute = has(me, roles, 'muteMembers')
  const canMove = has(me, roles, 'moveMembers')
  if (channelId === undefined || (!canMute && !canMove) || (!self && !outranks(me, member, roles))) return null
  const participant = server.voice[Number(channelId)].find((p) => p.accountKey === member.accountKey)
  const others = server.channels.filter((c) => c.kind === 'voice' && c.id !== Number(channelId))
  const run = (action: Promise<void>) => action.then(() => setError(null), (e) => setError(errorText(e)))

  return (
    <div className="voice-mod">
      <strong>{t('roles.inVoice', { channel: server.channels.find((c) => c.id === Number(channelId))?.name ?? '' })}</strong>
      <div className="copy-row">
        {canMute && (
          <button className="button" onClick={() => void run(serverMute(server.key, member.accountKey, !participant?.serverMuted))}>
            {participant?.serverMuted ? t('roles.unmuteAll') : t('roles.muteAll')}
          </button>
        )}
        {canMove && others.length > 0 && (
          <select aria-label={t('roles.moveLabel')} value="" onChange={(e) => e.target.value && void run(moveToChannel(server.key, member.accountKey, Number(e.target.value)))}>
            <option value="">{t('roles.moveTo')}</option>
            {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

// ── Channel permissions per role (channel settings) ─────────────────────────

const CHANNEL_PERMS: Record<'text' | 'voice', ChannelPermission[]> = {
  text: ['view', 'send'],
  voice: ['view', 'connect', 'speak'],
}

type Choice = 'deny' | 'inherit' | 'allow'

export function ChannelOverrides({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const me = server.me
  const [adding, setAdding] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (roles.length === 0) return null
  const overrides = channel.overrides ?? []
  const shown = [...overrides.map((o) => o.roleId), ...(adding !== null && !overrides.some((o) => o.roleId === adding) ? [adding] : [])]
  const addable = roles.filter((r) => !shown.includes(r.id) && isAbove(me, r.position, roles))
  const perms = CHANNEL_PERMS[channel.kind === 'voice' ? 'voice' : 'text']

  async function choose(roleId: number, perm: ChannelPermission, choice: Choice) {
    const current = overrides.find((o) => o.roleId === roleId) ?? { roleId, allow: [], deny: [] }
    const allow = current.allow.filter((p) => p !== perm)
    const deny = current.deny.filter((p) => p !== perm)
    if (choice === 'allow') allow.push(perm)
    if (choice === 'deny') deny.push(perm)
    try {
      await setOverride(server.key, channel.id, roleId, allow, deny)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <section className="channel-overrides">
      <strong>{t('roles.overridesTitle')}</strong>
      <p className="muted">{t('roles.overridesIntro')}</p>
      {shown.map((roleId) => {
        const role = roles.find((r) => r.id === roleId)
        if (!role) return null
        const o = overrides.find((x) => x.roleId === roleId)
        const editable = isAbove(me, role.position, roles)
        return (
          <div key={roleId} className="override-row" role="group" aria-label={t('roles.overridesFor', { role: role.name })}>
            <span className="override-role"><span className="role-dot" style={{ background: role.color ?? 'var(--muted)' }} aria-hidden />{role.name}</span>
            {perms.map((p) => {
              const value: Choice = o?.allow.includes(p) ? 'allow' : o?.deny.includes(p) ? 'deny' : 'inherit'
              const label = t(`roles.channel.${p}`)
              return (
                <div key={p} className="override-perm">
                  <span>{label}</span>
                  <div className="tri" role="radiogroup" aria-label={t('roles.permFor', { perm: label, role: role.name })}>
                    {(['deny', 'inherit', 'allow'] as const).map((c) => (
                      <button key={c} role="radio" aria-checked={value === c} className={`tri-${c} ${value === c ? 'on' : ''}`} disabled={!editable}
                        title={t(`roles.${c}`)} aria-label={t(`roles.${c}`)}
                        onClick={() => void choose(roleId, p, c)}>
                        {c === 'deny' ? '✕' : c === 'allow' ? '✓' : '/'}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
      {addable.length > 0 && (
        <select aria-label={t('roles.addRoleLabel')} value="" onChange={(e) => e.target.value && setAdding(Number(e.target.value))}>
          <option value="">{t('roles.addRole')}</option>
          {addable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  )
}
