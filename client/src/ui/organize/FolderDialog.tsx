// Name and colour of a server folder.
import { useState } from 'react'
import { FOLDER_COLORS, type RailFolder } from '../../state/railLogic'
import { Modal } from '../bits'

export function FolderDialog({ folder, onSave, onClose }: {
  folder: RailFolder
  onSave: (patch: { name: string; color: string }) => void
  onClose: () => void
}) {
  const [name, setName] = useState(folder.name)
  const [color, setColor] = useState(folder.color)
  const save = () => {
    onSave({ name: name.trim().slice(0, 32), color })
    onClose()
  }
  return (
    <Modal
      title="Folder settings"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" onClick={save}>Save</button>
        </>
      }
    >
      <label className="field">
        <span>Folder name</span>
        <input value={name} maxLength={32} placeholder="Gaming" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      <div className="field">
        <span>Colour</span>
        <div className="folder-colors" role="radiogroup" aria-label="Folder colour">
          {FOLDER_COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={c === color} aria-label={`Colour ${c}`} className={c === color ? 'on' : ''}
              style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <p className="muted">Folders follow you to your other devices.</p>
    </Modal>
  )
}
