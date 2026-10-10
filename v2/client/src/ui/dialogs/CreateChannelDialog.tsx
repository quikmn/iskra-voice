import { useState } from 'react'
import { ROLES, type Role } from '../../core/protocol'
import { connectionFor, selectChannel, type ServerState } from '../../state/store'
import { Modal } from '../bits'

export function CreateChannelDialog({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const [name, setName] = useState('')
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
        name: slug, readRole, writeRole: ROLES.indexOf(writeRole) < ROLES.indexOf(readRole) ? readRole : writeRole,
      })
      selectChannel(server.key, channel.id)
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
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} placeholder="game-night" />
      </label>
      {slug && <p className="muted">Will appear as <strong>#{slug}</strong></p>}
      <div className="options-row">
        <RolePicker label="Who can see it" value={readRole} onChange={setReadRole} />
        <RolePicker label="Who can post" value={writeRole} onChange={setWriteRole} min={readRole} />
      </div>
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
