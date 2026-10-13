// "Rent a small server": plain steps for a VPS, the setup text for its "User data" box, and claiming it as owner.
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { LINKS } from '../../links'
import { desktop } from '../../platform/desktop'
import { acceptInvite } from '../../state/store'
import { cloudInit, forgetPending, loadPending, newClaim, rememberPending, vpsAddress, vpsPrompt, waitForClaim, type ClaimProgress } from '../../state/rentServer'
import { Modal, Spinner } from '../bits'
import { OwnershipNote } from './ReachabilityHelp'
import { DigitalOceanDialog } from './DigitalOceanDialog'
import './RentServerDialog.css'

const TEMPLATES = ['gaming', 'friends', 'tabletop', 'empty'] as const
type TemplateId = (typeof TEMPLATES)[number]
const isTemplate = (v: unknown): v is TemplateId => TEMPLATES.includes(v as TemplateId)

const external = (href: string) => <a href={href} target="_blank" rel="noopener noreferrer" />

export function RentServerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<TemplateId>('gaming')
  const [claim, setClaim] = useState<string | null>(null)
  const [ip, setIp] = useState('')
  const [copied, setCopied] = useState(false)
  const [progress, setProgress] = useState<ClaimProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [promptCopied, setPromptCopied] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const [oneClick, setOneClick] = useState(false)

  // A server still waiting to be claimed (from the encrypted store), else a new owner key.
  useEffect(() => {
    let cancelled = false
    void loadPending().then((pending) => {
      if (cancelled) return
      if (pending) {
        setName(pending.name)
        setTemplate(isTemplate(pending.template) ? pending.template : 'gaming')
        setIp(pending.ip)
        setClaim(pending.claim)
      }
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (loaded && !claim) void newClaim().then(setClaim)
  }, [loaded, claim])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    if (loaded && claim) void rememberPending({ name, template, claim, ip })
  }, [loaded, name, template, claim, ip])

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

  /** A new owner key; the old one is deleted (a server set up with it can't be claimed from here any more). */
  function startOver() {
    stop()
    setCopied(false)
    void forgetPending().then(() => setClaim(null))
  }

  if (oneClick) return <DigitalOceanDialog onClose={onClose} />

  return (
    <Modal title={t('hosting.rent.title')} onClose={onClose} wide className="rent-server">
      <OwnershipNote />
      {desktop?.digitalOcean && (
        <div className="rent-do-entry" data-testid="rent-do-entry">
          <strong>{t('rental.entry.title')}</strong>
          <p className="muted">{t('rental.entry.text')}</p>
          <button className="button primary" onClick={() => { stop(); setOneClick(true) }}>{t('rental.entry.button')}</button>
        </div>
      )}
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
              <select value={template} onChange={(e) => { setTemplate(isTemplate(e.target.value) ? e.target.value : 'gaming'); setCopied(false) }}>
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
