// A file chooser in the app's look and language (the browser's own says "Choose File" in the browser's language).
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

export function FilePick({ label, accept, file, onPick, describe = (f) => f.name }: {
  label: string
  accept?: string
  file: File | null
  onPick: (file: File | null) => void
  /** What to show for a chosen file (its name by default). */
  describe?: (file: File) => string
}) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  return (
    <span className="file-pick">
      <button type="button" className="button small" onClick={() => input.current?.click()} aria-label={`${t('common.chooseFile')}: ${label}`}>
        {t('common.chooseFile')}
      </button>
      <span className="file-pick-name muted">{file ? describe(file) : t('common.noFileChosen')}</span>
      <input ref={input} type="file" hidden accept={accept} aria-label={label}
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null)
          e.target.value = ''
        }} />
    </span>
  )
}
