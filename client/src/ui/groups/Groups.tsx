// Group DMs: the sidebar rows, the conversation, and the dialogs to make a group, add people and manage it.
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { b64u } from '../../core/crypto'
import { asRename, MAX_GROUP_MEMBERS, MAX_GROUP_NAME, ownerOf } from '../../core/group'
import { isOnline } from '../../state/dms'
import { asGroupCallLine, changeText, timeline, type GroupMsg } from '../../state/groupLogic'
import {
  addToGroup, cannotSend, createGroup, discardGroupMessage, forgetGroup, groupCandidates, isArchived, isMember, leaveGroup, openGroup,
  knownName, removeFromGroup, renameGroup, sendGroupMessage, titleOf, useGroups, type GroupConv,
} from '../../state/groups'
import { useGroupCalls } from '../../state/groupCalls'
import { useDms } from '../../state/dms'
import { useApp } from '../../state/store'
import { dividerOf, dividerTarget, groupConv, useRead, useReads } from '../../state/readState'
import { UnreadBar, UnreadDivider } from '../organize/UnreadBits'
import { Avatar, Modal } from '../bits'
import { clockTime, fullTime, hueFor, messageTime } from '../format'
import { Lock, Menu, Pencil, Phone, Plus, Search, UserPlus, Users, Video } from '../icons'
import { renderMarkdown } from '../markdown'
import { DmAttachments, DmComposer } from '../dms/DmFiles'
import { usePrivateMessageTools } from '../productivity/MessageTools'
import { groupTarget, privateRowId } from '../../state/messageRefs'
import type { Panel } from '../Shell'
import { GroupCallButtons, GroupCallPanel, OngoingCallBanner } from './GroupCall'
import './groups.css'
import { Trans, useTranslation } from 'react-i18next'
import { groupText } from './groupText'
import { errorMessage } from '../../i18n/errors'
import { userMenuProps } from '../people/userMenuProps'
import { messageListKeys, useAnnounceNew } from '../a11y'

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
  const { t } = useTranslation()
  const groups = useGroups((s) => s.groups)
  const open = useDms((s) => s.open)
  const reads = useReads((s) => s.convs)
  const unread = (g: GroupConv) => reads[groupConv(g.key)]?.unread ?? 0
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
      className={`channel dm-row group-row ${open.kind === 'group' && open.key === g.key ? 'active' : ''} ${unread(g) && !old ? 'unread' : ''} ${isMember(g) && !old ? '' : 'former'}`}
      onClick={() => {
        openGroup(g.key)
        onNavigate()
      }}
    >
      <GroupAvatar members={g.view!.members} />
      <span className="channel-name">
        {titleOf(g)}
        <small>{old ? t('groups.archived') : t('groups.members', { count: g.view!.members.length })}</small>
      </span>
      {!old && calls[g.key] && <span className="group-call-dot" title={t('groups.callInProgress')}><Phone size={12} /></span>}
      {!old && unread(g) > 0 && <span className="badge">{unread(g)}</span>}
    </button>
  )
  return (
    <>
      <div className="channel-group">
        <span>{t('groups.groups')}</span>
        <button className="icon-button small" onClick={() => setCreating(true)} aria-label={t('groups.newGroup')} title={t('groups.newGroup')}>
          <Plus size={14} />
        </button>
      </div>
      {list.length === 0 && (
        <button className="channel new-group-row" onClick={() => setCreating(true)}>
          <span className="hash"><Users size={16} /></span>
          <span className="channel-name">{t('groups.newGroup')}</span>
        </button>
      )}
      {list.map((g) => row(g, false))}
      {archived.length > 0 && <div className="channel-group archived-heading"><span>{t('groups.archivedGroups')}</span></div>}
      {archived.map((g) => row(g, true))}
      {creating && <NewGroupDialog onClose={() => setCreating(false)} onCreated={onNavigate} />}
    </>
  )
}

// ── Picking people ─────────────────────────────────────────────────────────

function PeoplePicker({ candidates, picked, onChange, max }: { candidates: string[]; picked: string[]; onChange: (p: string[]) => void; max: number }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const shown = candidates
    .filter((k) => knownName(k).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)) || knownName(a).localeCompare(knownName(b)))
  return (
    <div className="people-picker">
      <label className="people-search">
        <Search size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('groups.findPeople')} aria-label={t('groups.findPeople')} />
      </label>
      <div className="people-list" role="group" aria-label={t('groups.people')}>
        {shown.length === 0 && <p className="muted people-empty">{candidates.length ? t('groups.nobodyByName') : t('groups.nobodyElse')}</p>}
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
  const { t } = useTranslation()
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
      setError(groupText(errorMessage(e)))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('groups.newGroup')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!enough || busy} onClick={() => void create()}>
            {busy ? t('groups.creating') : t('groups.createGroup')}
          </button>
        </>
      }
    >
      {online.length === 0 ? (
        <p className="muted">{t('groups.connectFirst')}</p>
      ) : (
        <>
          <p className="muted group-intro">{t('groups.pickIntro', { max: MAX_GROUP_MEMBERS - 1 })}</p>
          {online.length > 1 && (
            <label className="field">
              <span>{t('groups.server')}</span>
              <select value={serverKey} onChange={(e) => { setServerKey(e.target.value); setPicked([]) }}>
                {online.map((k) => <option key={k} value={k}>{servers[k].name}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span>{t('groups.nameOptional')}</span>
            <input value={name} maxLength={MAX_GROUP_NAME} onChange={(e) => setName(e.target.value)} placeholder={t('groups.namePlaceholder')} />
          </label>
          <PeoplePicker candidates={candidates} picked={picked} onChange={setPicked} max={MAX_GROUP_MEMBERS - 1} />
          <p className="muted picked-count" role="status">
            {picked.length === 0 ? t('groups.nobodyPicked') : enough ? t('groups.picked', { count: picked.length }) : t('groups.pickedMore', { count: picked.length })}
          </p>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

function AddPeopleDialog({ g, onClose }: { g: GroupConv; onClose: () => void }) {
  const { t } = useTranslation()
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
      setError(groupText(errorMessage(e)))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('groups.addPeople')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!picked.length || busy} onClick={() => void add()}>{t('common.add')}</button>
        </>
      }
    >
      {room <= 0 ? (
        <p className="muted">{t('groups.full', { max: MAX_GROUP_MEMBERS })}</p>
      ) : (
        <>
          <p className="muted group-intro">{t('groups.newPeopleNote')}</p>
          <PeoplePicker candidates={candidates} picked={picked} onChange={setPicked} max={room} />
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

function RenameDialog({ g, onClose }: { g: GroupConv; onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(g.name ?? '')
  const save = () => {
    void renameGroup(g.key, name)
    onClose()
  }
  return (
    <Modal
      title={t('groups.renameGroup')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={name.trim() === (g.name ?? '')} onClick={save}>{t('common.save')}</button>
        </>
      }
    >
      <label className="field">
        <span>{t('groups.groupName')}</span>
        <input value={name} maxLength={MAX_GROUP_NAME} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder={t('groups.noNamePlaceholder')} />
      </label>
      <p className="muted">{t('groups.renameNote')}</p>
    </Modal>
  )
}

function MembersDialog({ g, onClose, onAdd, onRename }: { g: GroupConv; onClose: () => void; onAdd: () => void; onRename: () => void }) {
  const { t } = useTranslation()
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
      setError(groupText(errorMessage(e)))
    }
  }

  return (
    <Modal title={`${titleOf(g)}`} onClose={onClose}>
      <h3 className="section-title">{t('groups.members', { count: members.length })}</h3>
      <div className="group-members">
        {members.map((k) => (
          <div key={k} className="friend-row" {...userMenuProps(k)}>
            <Avatar name={knownName(k)} accountKey={k} size={36} online={isOnline(k)} />
            <div className="friend-text">
              <strong>{k === me ? t('groups.nameYou', { name: knownName(k) }) : knownName(k)}</strong>
              <span className="muted">{k === owner ? t('groups.owner') : isOnline(k) ? t('groups.online') : t('groups.offline')}</span>
            </div>
            {member && owner === me && k !== me && (confirm === k ? (
              <>
                <button className="button small danger" onClick={() => void act(() => removeFromGroup(g.key, k))}>{t('groups.removeName', { name: knownName(k) })}</button>
                <button className="button small" onClick={() => setConfirm(null)}>{t('groups.keep')}</button>
              </>
            ) : (
              <button className="button small ghost" onClick={() => setConfirm(k)} aria-label={t('groups.removeFromGroup', { name: knownName(k) })}>{t('common.remove')}</button>
            ))}
          </div>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      {member && (
        <div className="group-actions">
          <button className="button" disabled={members.length >= MAX_GROUP_MEMBERS} onClick={onAdd}><UserPlus size={16} /> {t('groups.addPeople')}</button>
          <button className="button" onClick={onRename}><Pencil size={16} /> {t('groups.rename')}</button>
          {confirm === 'leave' ? (
            <>
              <button className="button danger" onClick={() => void act(async () => { await leaveGroup(g.key); onClose() })}>{t('groups.leaveForGood')}</button>
              <button className="button" onClick={() => setConfirm(null)}>{t('groups.stay')}</button>
            </>
          ) : (
            <button className="button danger ghost" onClick={() => setConfirm('leave')}>{t('groups.leaveGroup')}</button>
          )}
        </div>
      )}
      <p className="muted group-rules">
        {owner === me ? t('groups.rulesYou') : t('groups.rulesOther', { name: owner ? knownName(owner) : t('groups.theOwner') })}
      </p>
    </Modal>
  )
}

// ── The conversation ───────────────────────────────────────────────────────

export function GroupChat({ groupKey, onToggle }: { groupKey: string; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
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

  const divider = dividerOf(useRead(groupConv(groupKey)))
  const firstNew = divider && dividerTarget(g?.messages ?? [], divider.from, (m) => (m.pending || m.from === me ? null : { id: m.id, at: m.sentAt }))
  useAnnounceNew(g?.messages, (m) => (m.pending ? null : `${m.from}:${m.id}`),
    (m) => (m.from === me || m.group || m.call || m.error ? null : t('chat.a11y.newMessage', { name: knownName(m.from), text: m.text?.slice(0, 200) || t('chat.message.attachment') })))

  if (!g?.view) {
    return (
      <div className="chat">
        <header className="chat-header">
          <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('groups.openMenu')}><Menu /></button>
          <h1>{t('groups.group')}</h1>
        </header>
        <div className="empty-state"><p>{g?.problem ? groupText(g.problem) : t('groups.loading')}</p></div>
      </div>
    )
  }

  const groupItem = (item: (typeof items)[number], i: number) => {
    if (item.kind === 'change') return <SystemLine key={`c${item.change.version}`} text={changeText(item.change, me, knownName)} at={item.at} />
    const m = item.message
    const rename = !m.error ? asRename(m.group) : null
    if (rename) {
      if ((m.group as { silent?: unknown }).silent === true) return null
      const who = m.from === me ? t('groups.you') : knownName(m.from)
      return <SystemLine key={`${m.from}:${m.id}`} icon="pencil" text={rename.name ? t('groups.namedGroup', { who, name: rename.name }) : t('groups.removedName', { who })} at={m.sentAt} />
    }
    const callLine = !m.error ? asGroupCallLine(m.call) : null
    if (callLine) {
      const who = m.from === me ? t('groups.you') : knownName(m.from)
      return <SystemLine key={`${m.from}:${m.id}`} icon={callLine.video ? 'video' : 'phone'} text={callLine.video ? t('groups.startedVideo', { who }) : t('groups.startedVoice', { who })} at={m.sentAt} />
    }
    const prev = items[i - 1]
    const grouped = prev?.kind === 'message' && prev.message.from === m.from && m.sentAt - prev.message.sentAt < GROUP_WINDOW_MS
      && !prev.message.pending && !prev.message.error && !prev.message.group && !prev.message.call && m !== firstNew
    return <GroupRow key={`${m.from}:${m.id}`} m={m} grouped={grouped} groupKey={groupKey} mine={m.from === me} />
  }

  const reason = cannotSend(g)
  const title = titleOf(g)
  const inThisCall = joined?.key === groupKey
  const archived = isArchived(g)
  const member = isMember(g) && !archived

  return (
    <div className="chat group-chat">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('groups.openMenu')}><Menu /></button>
        <GroupAvatar members={g.view.members} />
        <h1 className="group-title">{title}</h1>
        <span className="e2e-badge" title={t('groups.onlyPeopleRead')}><Lock size={13} /> {t('groups.e2e')}</span>
        <span className="spacer" />
        {member && <GroupCallButtons groupKey={groupKey} />}
        <button className="icon-button" onClick={() => setDialog('members')} aria-label={t('groups.groupMembers')} title={t('groups.membersTitle')}>
          <Users />
        </button>
      </header>
      {inThisCall && <GroupCallPanel groupKey={groupKey} />}
      {call && !inThisCall && member && <OngoingCallBanner groupKey={groupKey} />}
      {archived && (
        <div className="archived-banner" role="status">
          <span><Trans i18nKey="groups.archivedBanner" components={{ b: <strong /> }} /></span>
          <button className="button small" onClick={() => forgetGroup(groupKey)}>{t('common.remove')}</button>
        </div>
      )}

      <div className="messages" ref={scroller} onKeyDown={messageListKeys} tabIndex={0} role="region" aria-label={t('chat.a11y.messages', { name: title })}>
        <UnreadBar conv={groupConv(groupKey)} scroller={scroller} onJump={() => undefined} catchUp={{ spec: { kind: 'group', key: groupKey }, title }} />
        <div className="channel-start">
          <GroupAvatar members={g.view.members} size={64} />
          <h2>{title}</h2>
          <p>{t('groups.start')}</p>
        </div>
        {g.problem && <p className="group-problem" role="alert"><Lock size={14} /> {groupText(g.problem)}</p>}
        {items.map((item, i) => (
          <Fragment key={item.kind === 'change' ? `c${item.change.version}` : `${item.message.from}:${item.message.id}`}>
            {item.kind === 'message' && item.message === firstNew && <UnreadDivider />}
            {groupItem(item, i)}
          </Fragment>
        ))}
      </div>

      <div className="typing-line" />
      {!reason ? (
        <DmComposer key={groupKey} peer="" placeholder={t('groups.messagePlaceholder', { title })} group={{ key: groupKey, serverKey: g.serverKey, id: g.id }} />
      ) : (
        <div className="composer read-only">
          {groupText(reason)}
          {!member && !archived && <button className="link" onClick={() => forgetGroup(groupKey)}>{t('groups.removeFromDevice')}</button>}
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
  const { t } = useTranslation()
  const name = knownName(m.from)
  const tools = usePrivateMessageTools(m.pending || m.error || m.call ? null : groupTarget(groupKey, m), m.text)
  return (
    <div id={privateRowId(m.from, m.id)} {...tools.rowProps} data-dm-id={m.id} className={`message ${grouped ? 'grouped' : ''} ${m.pending ?? ''} ${tools.rowProps.className ?? ''}`}
      role="article" tabIndex={-1} aria-label={t('chat.a11y.message', { name, time: fullTime(m.sentAt) })}>
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
          <div className="message-notice"><Lock size={13} /> {groupText(m.error)}</div>
        ) : (
          <>
            {m.text && <div className="message-text">{renderMarkdown(m.text, { nameOf: (k) => knownName(k) })}</div>}
            <DmAttachments files={m.files} />
          </>
        )}
        {m.pending === 'failed' && mine && (
          <div className="message-failed">
            {m.error ? groupText(m.error) : t('groups.couldNotSend')}{' '}
            <button className="link" onClick={() => { discardGroupMessage(groupKey, m.id); void sendGroupMessage(groupKey, m.text, m.files ? { files: m.files } : {}) }}>{t('common.retry')}</button>
            {' · '}
            <button className="link" onClick={() => discardGroupMessage(groupKey, m.id)}>{t('groups.discard')}</button>
          </div>
        )}
      </div>
      {tools.tools}
    </div>
  )
}
