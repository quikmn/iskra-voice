import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop, type ScreenSource } from '../platform/desktop'
import { Modal } from './bits'

/** Desktop only: choose which screen or window to share. */
export function ScreenPicker() {
  const { t } = useTranslation()
  const [sources, setSources] = useState<ScreenSource[] | null>(null)

  useEffect(() => desktop?.onPickScreen(setSources), [])

  if (!sources || !desktop) return null
  const choose = (id: string | null) => {
    desktop!.pickScreen(id)
    setSources(null)
  }
  const screens = sources.filter((s) => s.isScreen)
  const windows = sources.filter((s) => !s.isScreen)

  return (
    <Modal title={t('voice.share.title')} onClose={() => choose(null)}>
      {[{ title: t('voice.share.screens'), list: screens }, { title: t('voice.share.windows'), list: windows }].map(
        (group) =>
          group.list.length > 0 && (
            <section key={group.title} className="settings-section">
              <h3>{group.title}</h3>
              <div className="source-grid">
                {group.list.map((source) => (
                  <button key={source.id} className="source" onClick={() => choose(source.id)}>
                    <img src={source.thumbnail} alt="" />
                    <span>{source.name}</span>
                  </button>
                ))}
              </div>
            </section>
          ),
      )}
    </Modal>
  )
}
