// Name and colour of a server folder.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FOLDER_COLORS, type RailFolder } from '../../state/railLogic'
import { Modal } from '../bits'

export function FolderDialog({ folder, onSave, onClose }: {
  folder: RailFolder
  onSave: (patch: { name: string; color: string }) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(folder.name)
  const [color, setColor] = useState(folder.color)
  const save = () => {
    onSave({ name: name.trim().slice(0, 32), color })
    onClose()
  }
  return (
    <Modal
      title={t('organize.folder.title')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" onClick={save}>{t('common.save')}</button>
        </>
      }
    >
      <label className="field">
        <span>{t('organize.folder.name')}</span>
        <input value={name} maxLength={32} placeholder={t('organize.folder.placeholder')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      <div className="field">
        <span>{t('organize.folder.colour')}</span>
        <div className="folder-colors" role="radiogroup" aria-label={t('organize.folder.colourLabel')}>
          {FOLDER_COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={c === color} aria-label={t('organize.folder.colourOption', { color: c })} className={c === color ? 'on' : ''}
              style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <p className="muted">{t('organize.folder.hint')}</p>
    </Modal>
  )
}
