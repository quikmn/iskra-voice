import { useState } from 'react'
import { ROLES, type Role } from '../../core/protocol'
import { connectionFor, selectChannel, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { useCategories } from '../../state/organize'
import { Hash, Volume } from '../icons'

export function CreateChannelDialog({ server, categoryId: initialCategory = null, onClose }: { server: ServerState; categoryId?: number | null; onClose: () => void }) {
  const categories = useCategories(server.key)
  const [categoryId, setCategoryId] = useState<number | null>(initialCategory)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'text' | 'voice'>('text')
  const [readRole, setReadRole] = useState<Role>('member')
  const [writeRole, setWriteRole] = useState<Role>('member')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const slug = name.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-')

  async function create() {
    if (!slug || busy) return
    setBusy(true)
    try {
      const { channel } = await connectionFor(server.key)!.request('channel.create', {
        name: slug, kind, readRole, writeRole: ROLES.indexOf(writeRole) < ROLES.indexOf(readRole) ? readRole : writeRole,
        categoryId: categoryId ?? undefined,
      })
      if (channel.kind === 'text') selectChannel(server.key, channel.id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Create channel"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!slug || busy} onClick={() => void create()}>Create</button>
        </>
      }
    >
      <div className="segmented" role="radiogroup" aria-label="Channel type">
        <button role="radio" aria-checked={kind === 'text'} className={kind === 'text' ? 'on' : ''} onClick={() => setKind('text')}><Hash size={16} /> Text</button>
        <button role="radio" aria-checked={kind === 'voice'} className={kind === 'voice' ? 'on' : ''} onClick={() => setKind('voice')}><Volume size={16} /> Voice</button>
      </div>
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} placeholder="game-night" />
      </label>
      {slug && <p className="muted">Will appear as <strong>{kind === 'voice' ? '' : '#'}{slug}</strong></p>}
      <div className="options-row">
        <RolePicker label="Who can see it" value={readRole} onChange={setReadRole} />
        <RolePicker label={kind === 'voice' ? 'Who can speak' : 'Who can post'} value={writeRole} onChange={setWriteRole} min={readRole} />
      </div>
      {categories.length > 0 && (
        <label className="field inline">
          <span>Category</span>
          <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No category</option>
            {[...categories].sort((a, b) => a.position - b.position).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

export function RolePicker({ label, value, onChange, min = 'guest', max = 'owner' }: {
  label: string; value: Role; onChange: (r: Role) => void; min?: Role; max?: Role
}) {
  const options = ROLES.filter((r) => ROLES.indexOf(r) >= ROLES.indexOf(min) && ROLES.indexOf(r) <= ROLES.indexOf(max))
  return (
    <label className="field inline">
      <span>{label}</span>
      <select value={options.includes(value) ? value : options[0]} onChange={(e) => onChange(e.target.value as Role)}>
        {options.map((r) => <option key={r} value={r}>{r}+</option>)}
      </select>
    </label>
  )
}
