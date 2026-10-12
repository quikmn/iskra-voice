// "Rent a small server": plain steps for a VPS, the setup text for its "User data" box, and claiming it as owner.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { LINKS } from '../../links'
import { acceptInvite } from '../../state/store'
import { cloudInit, newClaim, vpsAddress, vpsPrompt, waitForClaim, type ClaimProgress } from '../../state/rentServer'
import { Modal, Spinner } from '../bits'
import { OwnershipNote } from './ReachabilityHelp'
import './RentServerDialog.css'

const TEMPLATES = ['gaming', 'friends', 'tabletop', 'empty'] as const
// Kept until the server is claimed, so closing this dialog while the server installs doesn't lose the owner key.
const SAVED = 'iskra.rentServer'

interface Saved {
  name: string
  template: (typeof TEMPLATES)[number]
  claim: string
  ip: string
}

function load(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(SAVED) ?? '{}') as Partial<Saved>
  } catch {
    return {}
  }
}

function save(value: Saved | null): void {
  try {
    if (value) localStorage.setItem(SAVED, JSON.stringify(value))
    else localStorage.removeItem(SAVED)
  } catch {
    /* private window: it just isn't remembered */
  }
}

const external = (href: string) => <a href={href} target="_blank" rel="noopener noreferrer" />

export function RentServerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const saved = useMemo(load, [])
  const [name, setName] = useState(saved.name ?? '')
  const [template, setTemplate] = useState<Saved['template']>(saved.template && TEMPLATES.includes(saved.template) ? saved.template : 'gaming')
  const [claim, setClaim] = useState<string | null>(saved.claim && /^[A-Za-z0-9_-]{43}$/.test(saved.claim) ? saved.claim : null)
  const [ip, setIp] = useState(saved.ip ?? '')
  const [copied, setCopied] = useState(false)
  const [progress, setProgress] = useState<ClaimProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [promptCopied, setPromptCopied] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!claim) void newClaim().then(setClaim)
  }, [claim])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    if (claim) save({ name, template, claim, ip })
  }, [name, template, claim, ip])

  const setup = claim ? cloudInit({ name: name.trim() || t('settings.createServer.namePlaceholder'), template, claim }) : ''

  async function copySetup() {
    await navigator.clipboard.writeText(setup)
    setCopied(true)
  }

  async function connect() {
    if (!claim) return
    if (!vpsAddress(ip)) {
      setError(t('hosting.rent.badIp'))
      return
    }
    setError(null)
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    try {
      const { invite } = await waitForClaim(ip, claim, { signal: controller.signal, onProgress: setProgress })
      save(null)
      acceptInvite(invite)
      onClose()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message)
      setProgress(null)
    }
  }

  function stop() {
    abort.current?.abort()
    setProgress(null)
  }

  function startOver() {
    stop()
    setCopied(false)
    setClaim(null)
  }

  return (
    <Modal title={t('hosting.rent.title')} onClose={onClose} wide className="rent-server">
      <OwnershipNote />
      <p className="muted">{t('hosting.rent.intro')}</p>
      <ol className="rent-steps">
        <li><Trans i18nKey="hosting.rent.step1" components={{ hetzner: external('https://www.hetzner.com/cloud'), digitalocean: external('https://www.digitalocean.com/products/droplets') }} /></li>
        <li><Trans i18nKey="hosting.rent.step2" components={{ b: <strong /> }} /></li>
        <li>
          <Trans i18nKey="hosting.rent.step3" components={{ b: <strong /> }} />
          <div className="rent-fields">
            <label className="field">
              <span>{t('hosting.rent.name')}</span>
              <input value={name} maxLength={60} placeholder={t('settings.createServer.namePlaceholder')} onChange={(e) => { setName(e.target.value); setCopied(false) }} />
            </label>
            <label className="field">
              <span>{t('hosting.rent.template')}</span>
              <select value={template} onChange={(e) => { setTemplate(e.target.value as Saved['template']); setCopied(false) }}>
                {TEMPLATES.map((id) => <option key={id} value={id}>{t(`hosting.wizard.template.${id}.name`)}</option>)}
              </select>
            </label>
          </div>
          <label className="field">
            <span>{t('hosting.rent.setup')}</span>
            <textarea className="rent-setup" readOnly rows={8} value={setup} onFocus={(e) => e.target.select()} data-testid="rent-setup" />
          </label>
          <p className="muted small">{t('hosting.rent.setupHint')}</p>
          <button className="button primary" disabled={!setup} onClick={() => void copySetup()}>{copied ? t('hosting.rent.copied') : t('hosting.rent.copy')}</button>
        </li>
        <li>
          <Trans i18nKey="hosting.rent.step4" components={{ b: <strong /> }} />
          <div className="rent-connect">
            <label className="field">
              <span>{t('hosting.rent.ip')}</span>
              <input value={ip} inputMode="decimal" placeholder={t('hosting.rent.ipPlaceholder')} onChange={(e) => setIp(e.target.value.trim())}
                onKeyDown={(e) => e.key === 'Enter' && !progress && void connect()} disabled={!!progress} />
            </label>
            {progress
              ? <button className="button" onClick={stop}>{t('hosting.rent.cancel')}</button>
              : <button className="button primary" disabled={!ip || !claim} onClick={() => void connect()}>{t('hosting.rent.connect')}</button>}
          </div>
          {progress && (
            <p className="rent-progress" role="status"><Spinner /> {t(`hosting.rent.${progress}`)}</p>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
        </li>
      </ol>
      <p className="muted small">
        <Trans i18nKey="hosting.rent.bring" components={{ move: external(`${LINKS.hostingGuide}#moving-a-server-to-another-computer`) }} />{' '}
        <button className="link" onClick={startOver}>{t('hosting.rent.newClaim')}</button>
      </p>
      {!asking ? (
        <button className="button" onClick={() => { setPrompt(vpsPrompt()); setAsking(true) }}>{t('hosting.rent.ai.button')}</button>
      ) : (
        <div className="ai-prompt" data-testid="rent-ai-prompt">
          <strong>{t('hosting.rent.ai.title')}</strong>
          <p className="muted">{t('hosting.rent.ai.intro')}</p>
          <label className="field">
            <span>{t('hosting.rent.ai.label')}</span>
            <textarea rows={10} value={prompt} maxLength={6000} onChange={(e) => { setPrompt(e.target.value); setPromptCopied(false) }} />
          </label>
          <button className="button primary" onClick={() => void navigator.clipboard.writeText(prompt).then(() => setPromptCopied(true))}>
            {promptCopied ? t('hosting.forward.ai.copied') : t('hosting.forward.ai.copy')}
          </button>
        </div>
      )}
    </Modal>
  )
}
