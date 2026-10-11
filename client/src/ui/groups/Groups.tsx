// Group DMs: the sidebar rows, the conversation, and the dialogs to make a group, add people and manage it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { b64u } from '../../core/crypto'
import { asRename, MAX_GROUP_MEMBERS, MAX_GROUP_NAME, ownerOf } from '../../core/group'
import { isOnline } from '../../state/dms'
import { asGroupCallLine, changeText, timeline, type GroupMsg } from '../../state/groupLogic'
import {
  addToGroup, cannotSend, createGroup, discardGroupMessage, forgetGroup, groupCandidates, isArchived, isMember, leaveGroup, markGroupRead, openGroup,
  knownName, removeFromGroup, renameGroup, sendGroupMessage, titleOf, useGroups, type GroupConv,
} from '../../state/groups'
import { useGroupCalls } from '../../state/groupCalls'
import { useDms } from '../../state/dms'
import { useApp } from '../../state/store'
import { Avatar, Modal } from '../bits'
import { clockTime, fullTime, hueFor, messageTime } from '../format'
import { Lock, Menu, Pencil, Phone, Plus, Search, UserPlus, Users, Video } from '../icons'
import { renderMarkdown } from '../markdown'
import { DmAttachments, DmComposer } from '../dms/DmFiles'
import type { Panel } from '../Shell'
import { GroupCallButtons, GroupCallPanel, OngoingCallBanner } from './GroupCall'
import './groups.css'

const GROUP_WINDOW_MS = 5 * 60 * 1000

const myKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** Two overlapping avatars of the other members. */
export function GroupAvatar({ members, size = 28 }: { members: string[]; size?: number }) {
  const me = myKey()
  const others = members.filter((m) => m !== me)
  const [a, b] = others.length ? others : [me]
  if (!b) return <Avatar name={knownName(a)} accountKey={a} size={size} />
  return (
    <span className="group-avatar" style={{ width: size, height: size }} aria-hidden>
      <Avatar name={knownName(a)} accountKey={a} size={Math.round(size * 0.66)} />
      <Avatar name={knownName(b)} accountKey={b} size={Math.round(size * 0.66)} />
    </span>
  )
}

/** The "Groups" part of the DM sidebar. */
export function GroupRows({ onNavigate }: { onNavigate: () => void }) {
  const groups = useGroups((s) => s.groups)
  const open = useDms((s) => s.open)
  const calls = useGroupCalls((s) => s.calls)
  const [creating, setCreating] = useState(false)
  useApp((s) => s.servers)
  const sorted = Object.values(groups)
    .filter((g) => g.view)
    .sort((a, b) => (b.messages.at(-1)?.sentAt ?? b.view!.changes.at(-1)!.at) - (a.messages.at(-1)?.sentAt ?? a.view!.changes.at(-1)!.at))
  const list = sorted.filter((g) => !isArchived(g))
  const archived = sorted.filter(isArchived)
  const row = (g: GroupConv, old: boolean) => (
    <button
      key={g.key}
      className={`channel dm-row group-row ${open.kind === 'group' && open.key === g.key ? 'active' : ''} ${g.unread && !old ? 'unread' : ''} ${isMember(g) && !old ? '' : 'former'}`}
      onClick={() => {
        openGroup(g.key)
        onNavigate()
      }}
    >
      <GroupAvatar members={g.view!.members} />
      <span className="channel-name">
        {titleOf(g)}
        <small>{old ? 'Archived' : `${g.view!.members.length} members`}</small>
      </span>
      {!old && calls[g.key] && <span className="group-call-dot" title="Call in progress"><Phone size={12} /></span>}
      {!old && g.unread > 0 && <span className="badge">{g.unread}</span>}
    </button>
  )
  return (
    <>
      <div className="channel-group">
        <span>Groups</span>
        <button className="icon-button small" onClick={() => setCreating(true)} aria-label="New group" title="New group">
          <Plus size={14} />
        </button>
      </div>
      {list.length === 0 && (
        <button className="channel new-group-row" onClick={() => setCreating(true)}>
          <span className="hash"><Users size={16} /></span>
          <span className="channel-name">New group</span>
        </button>
      )}
      {list.map((g) => row(g, false))}
      {archived.length > 0 && <div className="channel-group archived-heading"><span>Archived groups</span></div>}
      {archived.map((g) => row(g, true))}
      {creating && <NewGroupDialog onClose={() => setCreating(false)} onCreated={onNavigate} />}
    </>
  )
}

// ── Picking people ─────────────────────────────────────────────────────────

function PeoplePicker({ candidates, picked, onChange, max }: { candidates: string[]; picked: string[]; onChange: (p: string[]) => void; max: number }) {
  const [query, setQuery] = useState('')
  const shown = candidates
    .filter((k) => knownName(k).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)) || knownName(a).localeCompare(knownName(b)))
  return (
    <div className="people-picker">
      <label className="people-search">
        <Search size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find people" aria-label="Find people" />
      </label>
      <div className="people-list" role="group" aria-label="People">
        {shown.length === 0 && <p className="muted people-empty">{candidates.length ? 'Nobody by that name.' : 'Nobody else is on this server yet.'}</p>}
        {shown.map((k) => {
          const on = picked.includes(k)
          const full = !on && picked.length >= max
          return (
            <label key={k} className={`person-pick ${on ? 'on' : ''} ${full ? 'full' : ''}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={full}
                onChange={() => onChange(on ? picked.filter((p) => p !== k) : [...picked, k])}
              />
              <Avatar name={knownName(k)} accountKey={k} size={32} online={isOnline(k)} />
              <span className="person-name">{knownName(k)}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

export function NewGroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const servers = useApp((s) => s.servers)
  const order = useApp((s) => s.order)
  const online = order.filter((k) => servers[k]?.status.state === 'online')
  const [serverKey, setServerKey] = useState(online[0] ?? '')
  const [picked, setPicked] = useState<string[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const candidates = groupCandidates(serverKey)
  const enough = picked.length >= 2

  async function create() {
    if (!enough || busy) return
    setBusy(true)
    setError(null)
    try {
      await createGroup(serverKey, picked, name)
      onCreated?.()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New group"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!enough || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </>
      }
    >
      {online.length === 0 ? (
        <p className="muted">Connect to a server first: a group lives on a server you share with everyone in it.</p>
      ) : (
        <>
          <p className="muted group-intro">Pick 2 to {MAX_GROUP_MEMBERS - 1} people from a server you share. Messages and calls are end-to-end encrypted.</p>
          {online.length > 1 && (
            <label className="field">
              <span>Server</span>
              <select value={serverKey} onChange={(e) => { setServerKey(e.target.value); setPicked([]) }}>
                {online.map((k) => <option key={k} value={k}>{servers[k].name}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span>Group name (optional)</span>
            <input value={name} maxLength={MAX_GROUP_NAME} onChange={(e) => setName(e.target.value)} placeholder="Weekend crew" />
          </label>
          <PeoplePicker candidates={candidates} picked={picked} onChange={setPicked} max={MAX_GROUP_MEMBERS - 1} />
          <p className="muted picked-count" role="status">
            {picked.length === 0 ? 'Nobody picked yet' : `${picked.length} picked${enough ? '' : ': pick at least one more'}`}
          </p>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

function AddPeopleDialog({ g, onClose }: { g: GroupConv; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const members = g.view?.members ?? []
  const candidates = groupCandidates(g.serverKey).filter((k) => !members.includes(k))
  const room = MAX_GROUP_MEMBERS - members.length

  async function add() {
    if (!picked.length || busy) return
    setBusy(true)
    try {
      await addToGroup(g.key, picked)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add people"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!picked.length || busy} onClick={() => void add()}>Add</button>
        </>
      }
    >
      {room <= 0 ? (
        <p className="muted">This group is full ({MAX_GROUP_MEMBERS} people).</p>
      ) : (
        <>
          <p className="muted group-intro">New people see messages from now on, not the ones before they joined.</p>
          <PeoplePicker candidates={candidates} picked={picked} onChange={setPicked} max={room} />
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

function RenameDialog({ g, onClose }: { g: GroupConv; onClose: () => void }) {
  const [name, setName] = useState(g.name ?? '')
  const save = () => {
    void renameGroup(g.key, name)
    onClose()
  }
  return (
    <Modal
      title="Rename group"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={name.trim() === (g.name ?? '')} onClick={save}>Save</button>
        </>
      }
    >
      <label className="field">
        <span>Group name</span>
        <input value={name} maxLength={MAX_GROUP_NAME} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="No name: shows who's in it" />
      </label>
      <p className="muted">Everyone in the group sees the new name. The server never does: it's sent end-to-end encrypted.</p>
    </Modal>
  )
}

function MembersDialog({ g, onClose, onAdd, onRename }: { g: GroupConv; onClose: () => void; onAdd: () => void; onRename: () => void }) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const me = myKey()
  const members = g.view?.members ?? []
  const owner = g.view ? ownerOf(g.view) : undefined
  const member = isMember(g) && !isArchived(g)

  async function act(run: () => Promise<void>) {
    setError(null)
    try {
      await run()
      setConfirm(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Modal title={`${titleOf(g)}`} onClose={onClose}>
      <h3 className="section-title">{members.length} members</h3>
      <div className="group-members">
        {members.map((k) => (
          <div key={k} className="friend-row">
            <Avatar name={knownName(k)} accountKey={k} size={36} online={isOnline(k)} />
            <div className="friend-text">
              <strong>{k === me ? `${knownName(k)} (you)` : knownName(k)}</strong>
              <span className="muted">{k === owner ? 'Owner' : isOnline(k) ? 'Online' : 'Offline'}</span>
            </div>
            {member && owner === me && k !== me && (confirm === k ? (
              <>
                <button className="button small danger" onClick={() => void act(() => removeFromGroup(g.key, k))}>Remove {knownName(k)}</button>
                <button className="button small" onClick={() => setConfirm(null)}>Keep</button>
              </>
            ) : (
              <button className="button small ghost" onClick={() => setConfirm(k)} aria-label={`Remove ${knownName(k)} from the group`}>Remove</button>
            ))}
          </div>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      {member && (
        <div className="group-actions">
          <button className="button" disabled={members.length >= MAX_GROUP_MEMBERS} onClick={onAdd}><UserPlus size={16} /> Add people</button>
          <button className="button" onClick={onRename}><Pencil size={16} /> Rename</button>
          {confirm === 'leave' ? (
            <>
              <button className="button danger" onClick={() => void act(async () => { await leaveGroup(g.key); onClose() })}>Leave for good</button>
              <button className="button" onClick={() => setConfirm(null)}>Stay</button>
            </>
          ) : (
            <button className="button danger ghost" onClick={() => setConfirm('leave')}>Leave group</button>
          )}
        </div>
      )}
      <p className="muted group-rules">
        Anyone in the group can add people. {owner === me ? 'You can' : `${owner ? knownName(owner) : 'The owner'} can`} remove people; if the owner leaves, the
        longest-standing member takes over. Every change is signed by whoever made it and checked by every device, so a server can't slip anyone in.
      </p>
    </Modal>
  )
}

// ── The conversation ───────────────────────────────────────────────────────

export function GroupChat({ groupKey, onToggle }: { groupKey: string; onToggle: (panel: Panel) => void }) {
  const g = useGroups((s) => s.groups[groupKey])
  useApp((s) => s.servers)
  const joined = useGroupCalls((s) => s.joined)
  const call = useGroupCalls((s) => s.calls[groupKey])
  const [dialog, setDialog] = useState<'members' | 'add' | 'rename' | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const items = useMemo(() => (g ? timeline(g.messages, g.view) : []), [g])
  const me = myKey()

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length])

  useEffect(() => {
    if (g?.unread) markGroupRead(groupKey)
  }, [g?.unread, groupKey])

  if (!g?.view) {
    return (
      <div className="chat">
        <header className="chat-header">
          <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label="Open menu"><Menu /></button>
          <h1>Group</h1>
        </header>
        <div className="empty-state"><p>{g?.problem ?? 'Loading this group…'}</p></div>
      </div>
    )
  }

  const reason = cannotSend(g)
  const title = titleOf(g)
  const inThisCall = joined?.key === groupKey
  const archived = isArchived(g)
  const member = isMember(g) && !archived

  return (
    <div className="chat group-chat">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label="Open menu"><Menu /></button>
        <GroupAvatar members={g.view.members} />
        <h1 className="group-title">{title}</h1>
        <span className="e2e-badge" title="Only the people in this group can read these messages"><Lock size={13} /> End-to-end encrypted</span>
        <span className="spacer" />
        {member && <GroupCallButtons groupKey={groupKey} />}
        <button className="icon-button" onClick={() => setDialog('members')} aria-label="Group members" title="Members">
          <Users />
        </button>
      </header>
      {inThisCall && <GroupCallPanel groupKey={groupKey} />}
      {call && !inThisCall && member && <OngoingCallBanner groupKey={groupKey} />}
      {archived && (
        <div className="archived-banner" role="status">
          <span><strong>Archived.</strong> This group's server isn't in your server list any more, so the group is read-only here. It stays on this device until you remove it.</span>
          <button className="button small" onClick={() => forgetGroup(groupKey)}>Remove</button>
        </div>
      )}

      <div className="messages" ref={scroller}>
        <div className="channel-start">
          <GroupAvatar members={g.view.members} size={64} />
          <h2>{title}</h2>
          <p>This is the start of the group. Messages and calls are end-to-end encrypted: the server only passes them along.</p>
        </div>
        {g.problem && <p className="group-problem" role="alert"><Lock size={14} /> {g.problem}</p>}
        {items.map((item, i) => {
          if (item.kind === 'change') return <SystemLine key={`c${item.change.version}`} text={changeText(item.change, me, knownName)} at={item.at} />
          const m = item.message
          const rename = !m.error ? asRename(m.group) : null
          if (rename) {
            if ((m.group as { silent?: unknown }).silent === true) return null
            const who = m.from === me ? 'You' : knownName(m.from)
            return <SystemLine key={`${m.from}:${m.id}`} icon="pencil" text={rename.name ? `${who} named the group ${rename.name}` : `${who} removed the group name`} at={m.sentAt} />
          }
          const callLine = !m.error ? asGroupCallLine(m.call) : null
          if (callLine) {
            const who = m.from === me ? 'You' : knownName(m.from)
            return <SystemLine key={`${m.from}:${m.id}`} icon={callLine.video ? 'video' : 'phone'} text={`${who} started a ${callLine.video ? 'video' : 'voice'} call`} at={m.sentAt} />
          }
          const prev = items[i - 1]
          const grouped = prev?.kind === 'message' && prev.message.from === m.from && m.sentAt - prev.message.sentAt < GROUP_WINDOW_MS
            && !prev.message.pending && !prev.message.error && !prev.message.group && !prev.message.call
          return <GroupRow key={`${m.from}:${m.id}`} m={m} grouped={grouped} groupKey={groupKey} mine={m.from === me} />
        })}
      </div>

      <div className="typing-line" />
      {!reason ? (
        <DmComposer key={groupKey} peer="" placeholder={`Message ${title}`} group={{ key: groupKey, serverKey: g.serverKey, id: g.id }} />
      ) : (
        <div className="composer read-only">
          {reason}
          {!member && !archived && <button className="link" onClick={() => forgetGroup(groupKey)}>Remove from this device</button>}
        </div>
      )}

      {dialog === 'members' && <MembersDialog g={g} onClose={() => setDialog(null)} onAdd={() => setDialog('add')} onRename={() => setDialog('rename')} />}
      {dialog === 'add' && <AddPeopleDialog g={g} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameDialog g={g} onClose={() => setDialog(null)} />}
    </div>
  )
}

function SystemLine({ text, at, icon }: { text: string; at: number; icon?: 'pencil' | 'phone' | 'video' }) {
  return (
    <div className="system-line">
      <span className="system-icon">{icon === 'pencil' ? <Pencil size={14} /> : icon === 'phone' ? <Phone size={14} /> : icon === 'video' ? <Video size={14} /> : <Users size={14} />}</span>
      <span>{text}</span>
      <time title={fullTime(at)}>{messageTime(at)}</time>
    </div>
  )
}

function GroupRow({ m, grouped, groupKey, mine }: { m: GroupMsg; grouped: boolean; groupKey: string; mine: boolean }) {
  const name = knownName(m.from)
  return (
    <div className={`message ${grouped ? 'grouped' : ''} ${m.pending ?? ''}`}>
      <div className="message-gutter">
        {grouped ? <time className="hover-time" title={fullTime(m.sentAt)}>{clockTime(m.sentAt)}</time> : <Avatar name={name} accountKey={m.from} />}
      </div>
      <div className="message-body">
        {!grouped && (
          <div className="message-meta">
            <span className="author" style={{ color: `hsl(${hueFor(m.from)} 70% var(--name-l))` }}>{name}</span>
            <time title={fullTime(m.sentAt)}>{messageTime(m.sentAt)}</time>
          </div>
        )}
        {m.error && !m.pending ? (
          <div className="message-notice"><Lock size={13} /> {m.error}</div>
        ) : (
          <>
            {m.text && <div className="message-text">{renderMarkdown(m.text, { nameOf: (k) => knownName(k) })}</div>}
            <DmAttachments files={m.files} />
          </>
        )}
        {m.pending === 'failed' && mine && (
          <div className="message-failed">
            {m.error ?? "Couldn't send."}{' '}
            <button className="link" onClick={() => { discardGroupMessage(groupKey, m.id); void sendGroupMessage(groupKey, m.text, m.files ? { files: m.files } : {}) }}>Retry</button>
            {' · '}
            <button className="link" onClick={() => discardGroupMessage(groupKey, m.id)}>Discard</button>
          </div>
        )}
      </div>
    </div>
  )
}
