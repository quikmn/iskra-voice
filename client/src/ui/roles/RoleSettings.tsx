// Custom roles: Settings → This server → Roles (create, edit, drag to reorder), role chips on profiles,
// giving roles to a member, channel permissions per role, and voice moderation (mute, move).
import { useState, type DragEvent } from 'react'
import type { Channel, ChannelPermission, Member, Permission, ServerRole } from '../../core/protocol'
import {
  createRole, deleteRole, moveToChannel, reorderRoles, serverMute, setMemberRoles, setOverride, updateRole, useServerRoles,
} from '../../state/roles'
import { has, isAbove, isAdmin, MODERATOR_PRESET, outranks, PERMISSIONS, rolesOf } from '../../state/permissions'
import type { ServerState } from '../../state/store'
import './roles.css'

const errorText = (e: unknown) => (e as Error).message

// ── Role chips ──────────────────────────────────────────────────────────────

export function RoleChips({ server, member }: { server: ServerState; member: Member }) {
  const roles = rolesOf(member, useServerRoles(server.key))
  if (roles.length === 0) return null
  return (
    <ul className="role-chips" aria-label="Roles">
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
      const role = await createRole(server.key, { name: 'New role' })
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
      <h3>Roles</h3>
      <p className="muted">
        Roles give people names, colours and powers on top of their level. Higher roles come first: people can only manage roles
        and members below their own highest role. Drag to reorder.
      </p>
      <button className="button primary" onClick={() => void add()}>Create role</button>
      {error && <p className="error-text">{error}</p>}
      {roles.length === 0 ? (
        <p className="empty-note">No roles yet. Create one, for example a Moderator.</p>
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
                    <button className="icon-button small" aria-label={`Move ${r.name} up`} disabled={i === 0 || !isAbove(me, roles[i - 1].position, roles)}
                      onClick={() => void move(r.id, i - 1)}>↑</button>
                    <button className="icon-button small" aria-label={`Move ${r.name} down`} disabled={i === roles.length - 1}
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
  const roles = useServerRoles(server.key)
  const me = server.me
  const editable = isAbove(me, role.position, roles)
  const [name, setName] = useState(role.name)
  const [color, setColor] = useState(role.color)
  const [icon, setIcon] = useState(role.icon ?? '')
  const [hoist, setHoist] = useState(role.hoist)
  const [perms, setPerms] = useState<Permission[]>(role.permissions)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // You can only hand out permissions you have (a permission the role already has can stay).
  const grantable = (p: Permission) => isAdmin(me) || has(me, roles, p) || role.permissions.includes(p)

  async function save() {
    try {
      await updateRole(server.key, role.id, { name, color: color ?? '', icon, hoist, permissions: perms })
      setError(null)
      setStatus('Saved')
    } catch (e) {
      setError(errorText(e))
      setStatus(null)
    }
  }

  return (
    <div className="role-editor" aria-label={`Edit ${role.name}`} role="group">
      <div className="role-editor-fields">
        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={32} disabled={!editable} aria-label="Role name" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field role-icon-field">
          <span>Icon</span>
          <input value={icon} maxLength={16} placeholder="None" disabled={!editable} onChange={(e) => setIcon(e.target.value.trim())} aria-label="Role icon emoji" />
        </label>
        <div className="field">
          <span>Colour</span>
          <div className="copy-row">
            <input type="color" className="color-input" value={color ?? '#99aab5'} disabled={!editable} aria-label="Role colour"
              onChange={(e) => setColor(e.target.value)} />
            <button className="button small" disabled={!editable || !color} onClick={() => setColor(null)}>No colour</button>
          </div>
        </div>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={hoist} disabled={!editable} onChange={(e) => setHoist(e.target.checked)} />
        Show people with this role separately in the member list
      </label>
      <div className="role-perms-head">
        <strong>Permissions</strong>
        <button className="button small" disabled={!editable} onClick={() => setPerms(MODERATOR_PRESET.filter(grantable))}>Moderator preset</button>
        <button className="button small ghost" disabled={!editable} onClick={() => setPerms([])}>Clear</button>
      </div>
      <ul className="role-perms">
        {PERMISSIONS.map((p) => (
          <li key={p.id}>
            <label className="checkbox">
              <input
                type="checkbox" checked={perms.includes(p.id)} disabled={!editable || !grantable(p.id)}
                onChange={(e) => setPerms(e.target.checked ? [...perms, p.id] : perms.filter((x) => x !== p.id))}
              />
              <span>
                <span>{p.label}</span>
                <small className="muted">{p.hint}</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {!editable && <p className="muted">This role is at or above your highest role, so you can't change it.</p>}
      {error && <p className="error-text">{error}</p>}
      {editable && (
        <div className="copy-row role-editor-actions">
          <button className="button primary" onClick={() => void save()}>Save role</button>
          {status && <span className="muted" role="status">{status}</span>}
          <span className="spacer" />
          {confirmDelete ? (
            <>
              <button className="button danger" onClick={() => void deleteRole(server.key, role.id).then(onDeleted, (e) => setError(errorText(e)))}>Delete</button>
              <button className="button" onClick={() => setConfirmDelete(false)}>Keep</button>
            </>
          ) : (
            <button className="button danger-outline" onClick={() => setConfirmDelete(true)}>Delete role</button>
          )}
        </div>
      )}
    </div>
  )
}

// ── A member's roles (member dialog) ────────────────────────────────────────

export function MemberRolesEditor({ server, member }: { server: ServerState; member: Member }) {
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
      <strong>Roles</strong>
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
      <strong>In voice · #{server.channels.find((c) => c.id === Number(channelId))?.name}</strong>
      <div className="copy-row">
        {canMute && (
          <button className="button" onClick={() => void run(serverMute(server.key, member.accountKey, !participant?.serverMuted))}>
            {participant?.serverMuted ? 'Unmute for everyone' : 'Mute for everyone'}
          </button>
        )}
        {canMove && others.length > 0 && (
          <select aria-label="Move to channel" value="" onChange={(e) => e.target.value && void run(moveToChannel(server.key, member.accountKey, Number(e.target.value)))}>
            <option value="">Move to…</option>
            {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

// ── Channel permissions per role (channel settings) ─────────────────────────

const CHANNEL_PERMS: Record<'text' | 'voice', { id: ChannelPermission; label: string }[]> = {
  text: [{ id: 'view', label: 'See the channel' }, { id: 'send', label: 'Send messages' }],
  voice: [{ id: 'view', label: 'See the channel' }, { id: 'connect', label: 'Connect' }, { id: 'speak', label: 'Speak' }],
}

type Choice = 'deny' | 'inherit' | 'allow'

export function ChannelOverrides({ server, channel }: { server: ServerState; channel: Channel }) {
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
      <strong>Permissions by role</strong>
      <p className="muted">On top of who can read and write. A role's allow wins over another role's deny.</p>
      {shown.map((roleId) => {
        const role = roles.find((r) => r.id === roleId)
        if (!role) return null
        const o = overrides.find((x) => x.roleId === roleId)
        const editable = isAbove(me, role.position, roles)
        return (
          <div key={roleId} className="override-row" role="group" aria-label={`Permissions for ${role.name}`}>
            <span className="override-role"><span className="role-dot" style={{ background: role.color ?? 'var(--muted)' }} aria-hidden />{role.name}</span>
            {perms.map((p) => {
              const value: Choice = o?.allow.includes(p.id) ? 'allow' : o?.deny.includes(p.id) ? 'deny' : 'inherit'
              return (
                <div key={p.id} className="override-perm">
                  <span>{p.label}</span>
                  <div className="tri" role="radiogroup" aria-label={`${p.label} for ${role.name}`}>
                    {(['deny', 'inherit', 'allow'] as const).map((c) => (
                      <button key={c} role="radio" aria-checked={value === c} className={`tri-${c} ${value === c ? 'on' : ''}`} disabled={!editable}
                        title={c === 'inherit' ? 'Default' : c === 'allow' ? 'Allow' : 'Deny'} aria-label={c === 'inherit' ? 'Default' : c === 'allow' ? 'Allow' : 'Deny'}
                        onClick={() => void choose(roleId, p.id, c)}>
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
        <select aria-label="Add a role" value="" onChange={(e) => e.target.value && setAdding(Number(e.target.value))}>
          <option value="">Add a role…</option>
          {addable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  )
}
