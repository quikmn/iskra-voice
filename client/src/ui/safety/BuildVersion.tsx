// "Iskra 2.0.0-alpha.14 · a89a580" in About & legal, with a button to copy it for bug reports.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildLabel } from '../../buildInfo'
import { Copy } from '../icons'

export function BuildVersion({ label = buildLabel() }: { label?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const text = t('safety.about.version', { version: label })
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard not allowed */
    }
  }
  return (
    <p className="muted about-version">
      <span data-testid="build-version">{text}</span>
      <button className="button small" onClick={() => void copy()} aria-label={t('safety.about.copyVersion')} title={t('safety.about.copyVersion')}>
        {copied ? t('common.copied') : <Copy size={14} />}
      </button>
    </p>
  )
}
