// Admin dialogs: naming a category, and a channel's settings (name, who can see and post, slowmode, category, delete).
import { useState } from 'react'
import { ROLES, type Category, type Channel, type Role } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { createCategory, moveChannel, renameCategory, useCategories } from '../../state/organize'
import { Modal } from '../bits'
import { RolePicker } from '../dialogs/CreateChannelDialog'
import { slowmodeLabel, SLOWMODE_STEPS } from '../../state/moderationRules'
import { ChannelOverrides } from '../roles/RoleSettings'
import { UserLimitField } from '../rules/UserLimitField'

export function CategoryDialog({ server, category, onClose }: { server: ServerState; category?: Category; onClose: () => void }) {
  const [name, setName] = useState(category?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()

  async function save() {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      if (category) await renameCategory(server.key, category.id, trimmed)
      else await createCategory(server.key, trimmed)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={category ? 'Rename category' : 'Create category'}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!trimmed || busy || trimmed === category?.name} onClick={() => void save()}>
            {category ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} placeholder="Games" />
      </label>
      {!category && <p className="muted">Drag channels into it, or use a channel's menu to move it there. Everyone only sees the channels they can open.</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

export function ChannelSettingsDialog({ server, channel, onClose }: { server: ServerState; channel: Channel; onClose: () => void }) {
  const categories = useCategories(server.key)
  const [name, setName] = useState(channel.name)
  const [readRole, setReadRole] = useState<Role>(channel.readRole)
  const [writeRole, setWriteRole] = useState<Role>(channel.writeRole)
  const [categoryId, setCategoryId] = useState<number | null>(channel.categoryId ?? null)
  const [slowmode, setSlowmode] = useState(channel.slowmode ?? 0)
  const hasSlowmode = channel.kind === 'text' || channel.kind === 'forum'
  const [userLimit, setUserLimit] = useState(channel.userLimit ?? 0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const slug = name.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-')
  const write = ROLES.indexOf(writeRole) < ROLES.indexOf(readRole) ? readRole : writeRole

  async function act(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    try {
      await action()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const save = () => act(async () => {
    const connection = connectionFor(server.key)
    if (!connection) throw new Error('Not connected.')
    await connection.request('channel.update', {
      id: channel.id, name: slug, readRole, writeRole: write, slowmode: hasSlowmode ? slowmode : undefined,
      userLimit: channel.kind === 'voice' ? userLimit : undefined,
    })
    if (categoryId !== (channel.categoryId ?? null)) await moveChannel(server.key, channel.id, categoryId, null)
  })

  return (
    <Modal
      title={`${channel.kind === 'text' || channel.kind === 'forum' ? '#' : ''}${channel.name} settings`}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!slug || busy} onClick={() => void save()}>Save</button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </label>
      <div className="options-row">
        <RolePicker label="Who can see it" value={readRole} onChange={setReadRole} />
        <RolePicker label={channel.kind === 'voice' ? 'Who can speak' : channel.kind === 'stage' ? 'Who can ask to speak' : 'Who can post'} value={write} onChange={setWriteRole} min={readRole} />
      </div>
      {hasSlowmode && (
        <label className="field">
          <span>Slowmode · {slowmode ? `one message every ${slowmodeLabel(slowmode)}` : 'off'}</span>
          <input
            type="range" min={0} max={SLOWMODE_STEPS.length - 1} step={1} aria-label="Slowmode"
            value={Math.max(0, SLOWMODE_STEPS.indexOf(slowmode as (typeof SLOWMODE_STEPS)[number]))}
            onChange={(e) => setSlowmode(SLOWMODE_STEPS[Number(e.target.value)])}
          />
          <small className="muted">Members can send one message per interval here. Admins aren't limited.</small>
        </label>
      )}
      {channel.kind === 'voice' && <UserLimitField value={userLimit} onChange={setUserLimit} />}
      <ChannelOverrides server={server} channel={channel} />
      <label className="field inline">
        <span>Category</span>
        <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">No category</option>
          {[...categories].sort((a, b) => a.position - b.position).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="settings-danger">
        <div>
          <strong>Delete channel</strong>
          <p className="muted">Deletes its messages, threads and pins for everyone. This can't be undone.</p>
        </div>
        {confirmDelete ? (
          <div className="copy-row">
            <button className="button danger" disabled={busy}
              onClick={() => void act(() => connectionFor(server.key)!.request('channel.delete', { id: channel.id }))}>
              Delete
            </button>
            <button className="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : (
          <button className="button danger-outline" onClick={() => setConfirmDelete(true)}>Delete channel</button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
