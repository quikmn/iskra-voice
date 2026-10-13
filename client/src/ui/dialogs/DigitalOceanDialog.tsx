// "Rent a server on DigitalOcean" (desktop app): account, token, place, then the app creates and claims the server.
// The token goes to the desktop app's main process once (desktop/src/digitalocean.ts); this page never keeps it.
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { LINKS } from '../../links'
import { desktop, type DoCreated, type DoRegionChoice, type DoStep } from '../../platform/desktop'
import { documentFileName, errorText, formatMemory, formatPrice, guessRegion, serverDocument, userTimeZone, type RentedServer } from '../../state/doRental'
import { cloudInit, forgetPending, newClaim, rememberPending, waitForClaimAt } from '../../state/rentServer'
import { acceptInvite } from '../../state/store'
import { Modal, Spinner } from '../bits'
import './CreateServerDialog.css'
import './RentServerDialog.css'
import './DigitalOceanDialog.css'

const TEMPLATES = ['gaming', 'friends', 'tabletop', 'empty'] as const
type TemplateId = (typeof TEMPLATES)[number]
const isTemplate = (v: unknown): v is TemplateId => TEMPLATES.includes(v as TemplateId)

type Step = 'account' | 'token' | 'place' | 'create' | 'done'
const STEPS: Exclude<Step, 'done'>[] = ['account', 'token', 'place', 'create']
type Phase = Exclude<DoStep, 'ready'> | 'claiming'
const PHASES: Phase[] = ['droplet', 'firewall', 'booting', 'installing', 'claiming']

const external = (href: string) => <a href={href} target="_blank" rel="noopener noreferrer" />

interface Failure {
  text: string
  detail: string | null
  /** The server answered too slowly: waiting longer may still work. */
  canWait: boolean
}

/** Desktop only: the web app shows the manual steps (RentServerDialog) instead. */
export function DigitalOceanDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const bridge = desktop?.digitalOcean
  const [step, setStep] = useState<Step>('account')
  const [token, setToken] = useState('')
  const [checking, setChecking] = useState(false)
  // Connect in the browser (OAuth) first; the pasted token is the fallback.
  const [oauth, setOauth] = useState(false)
  const [useToken, setUseToken] = useState(false)
  const [regions, setRegions] = useState<DoRegionChoice[]>([])
  const [region, setRegion] = useState('')
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<TemplateId>('gaming')
  const [ssh, setSsh] = useState(false)
  const [phase, setPhase] = useState<Phase | null>(null)
  const [address, setAddress] = useState<{ ip: string; url: string } | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [created, setCreated] = useState<DoCreated>({})
  const [cleaning, setCleaning] = useState<'no' | 'busy' | 'done' | 'failed'>('no')
  const [asking, setAsking] = useState(false)
  const [kept, setKept] = useState(false)
  const [rented, setRented] = useState<RentedServer | null>(null)
  const [saved, setSaved] = useState(false)
  const claim = useRef<{ claim: string; name: string; template: string } | null>(null)
  const waiting = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    void bridge?.oauthAvailable?.().then((on) => alive && setOauth(on === true)).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [bridge])

  // The token is dropped from the main process when this closes, whatever happened.
  useEffect(() => () => {
    waiting.current?.abort()
    void bridge?.forget()
  }, [bridge])

  const choice = regions.find((r) => r.slug === region) ?? null
  const serverName = name.trim()
  const busy = step === 'create' && !failure
  const hasServer = created.dropletId !== undefined && cleaning !== 'done'

  async function connect(viaBrowser = false) {
    if (!bridge || checking) return
    setChecking(true)
    setFailure(null)
    const reply = await (viaBrowser && bridge.oauth ? bridge.oauth() : bridge.connect(token.trim())).catch(() => null)
    setChecking(false)
    if (!reply) return setFailure({ ...errorText('network'), canWait: false })
    if (!reply.ok) return reply.error === 'cancelled' ? undefined : setFailure({ ...errorText(reply.error, reply.detail), canWait: false })
    setToken('') // only the main process has it now
    setRegions(reply.regions)
    setRegion((r) => (reply.regions.some((x) => x.slug === r) ? r : (guessRegion(userTimeZone(), reply.regions) ?? '')))
    setStep('place')
  }

  async function create() {
    if (!bridge || !choice || !serverName) return
    setStep('create')
    setFailure(null)
    setCreated({})
    setCleaning('no')
    setAddress(null)
    setPhase('droplet')
    const owner = { claim: await newClaim(), name: serverName, template }
    claim.current = owner
    await rememberPending({ ...owner, ip: '' })
    const stop = bridge.onProgress((p) => {
      setPhase(p.step === 'ready' ? 'installing' : p.step)
      if (p.ip && p.url) {
        setAddress({ ip: p.ip, url: p.url })
        void rememberPending({ ...owner, ip: p.ip })
      }
    })
    try {
      const userData = cloudInit({ name: serverName, template, claim: owner.claim })
      const reply = await bridge.create({ name: serverName, region: choice.slug, size: choice.size.slug, userData, ssh }).catch(() => null)
      if (!reply || !reply.ok) {
        if (reply) setCreated(reply.created)
        const err = reply ? errorText(reply.error, reply.detail) : errorText('network')
        setFailure({ ...err, canWait: !!reply && reply.error === 'timeout' && reply.detail === 'install' })
        return
      }
      setCreated({ dropletId: reply.server.dropletId, dropletName: reply.server.dropletName })
      setAddress({ ip: reply.server.ip, url: reply.server.url })
      await finish(reply.server.url, reply.server.ip, reply.server.dropletName)
    } finally {
      stop()
    }
  }

  /** The server answers: prove it's ours, join as owner, and forget the token. */
  async function finish(url: string, ip: string, dropletName: string, timeoutMs = 3 * 60_000) {
    const owner = claim.current
    if (!owner || !choice) return
    setPhase('claiming')
    setFailure(null)
    waiting.current?.abort()
    const controller = new AbortController()
    waiting.current = controller
    try {
      const { invite } = await waitForClaimAt(url, owner.claim, { signal: controller.signal, timeoutMs })
      acceptInvite(invite)
      await forgetPending()
      void bridge?.forget()
      setRented({ name: owner.name, url, ip, dropletName, region: choice.slug, regionName: choice.name, size: choice.size, ssh, createdAt: new Date() })
      setStep('done')
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setFailure({ text: (e as Error).message, detail: null, canWait: true })
    }
  }

  async function keepWaiting() {
    if (!address || !created.dropletName) return
    await finish(address.url, address.ip, created.dropletName, 20 * 60_000)
  }

  async function cleanUp() {
    if (!bridge) return
    waiting.current?.abort()
    setAsking(false)
    setCleaning('busy')
    const reply = await bridge.cleanUp().catch(() => null)
    if (reply?.ok) {
      setCreated({})
      setCleaning('done')
      setFailure((f) => f ?? { ...errorText('cancelled'), canWait: false })
      await forgetPending()
    } else {
      if (reply) setCreated(reply.created)
      setCleaning('failed')
    }
  }

  function close() {
    if ((busy || (failure && hasServer)) && !kept && step !== 'done') return setAsking(true)
    onClose()
  }

  function keep() {
    waiting.current?.abort()
    void bridge?.cancel()
    void bridge?.forget()
    setAsking(false)
    setKept(true)
  }

  async function save() {
    if (!rented) return
    const text = serverDocument(rented)
    const fileName = documentFileName(rented.name)
    const bytes = new TextEncoder().encode(text)
    const files = desktop?.saveFile
    if (files) {
      const id = await files.begin(fileName)
      if (!id) return
      if ((await files.write(id, bytes)) && (await files.finish(id))) setSaved(true)
      else await files.abort(id)
      return
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'text/markdown' }))
    a.download = fileName
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    setSaved(true)
  }

  const progressBar = step !== 'done' && (
    <ol className="wizard-steps" aria-label={t('rental.steps.label')}>
      {STEPS.map((s, i) => (
        <li key={s} className={s === step ? 'current' : STEPS.indexOf(step as (typeof STEPS)[number]) > i ? 'done' : ''} aria-current={s === step ? 'step' : undefined}>
          {t(`rental.steps.${s}`)}
        </li>
      ))}
    </ol>
  )

  if (!bridge) {
    return (
      <Modal title={t('rental.title')} onClose={onClose}>
        <p>{t('rental.errors.unavailable')}</p>
      </Modal>
    )
  }

  if (asking) {
    return (
      <Modal title={t('rental.title')} heading={t('rental.stopAsk.heading')} onClose={() => setAsking(false)} className="do-rental"
        footer={
          <>
            <button className="button" onClick={() => setAsking(false)}>{t('rental.stopAsk.back')}</button>
            <button className="button" onClick={keep}>{t('rental.stopAsk.keep')}</button>
            <button className="button danger" onClick={() => void cleanUp()}>{t('rental.stopAsk.delete')}</button>
          </>
        }
      >
        <p>{t('rental.stopAsk.text')}</p>
      </Modal>
    )
  }

  if (step === 'done' && rented) {
    const price = formatPrice(rented.size.priceMonthly)
    return (
      <Modal title={t('rental.title')} heading={t('rental.done.heading')} onClose={onClose} className="do-rental"
        footer={<button className="button primary" onClick={onClose}>{t('rental.done.close')}</button>}
      >
        <p>{t('rental.done.text', { name: rented.name })}</p>
        <dl className="do-facts" data-testid="do-done">
          <dt>{t('rental.done.address')}</dt>
          <dd><code>{rented.url}</code></dd>
          <dt>{t('rental.done.cost')}</dt>
          <dd>{t('rental.done.costValue', { price })}</dd>
        </dl>
        <div className="do-save">
          <button className="button primary" onClick={() => void save()}>{saved ? t('rental.done.saved') : t('rental.done.save')}</button>
          <p className="muted small">{t('rental.done.saveHint')}</p>
        </div>
        <p className="muted small"><Trans i18nKey="rental.done.tokenGone" components={{ tokens: external(LINKS.digitalOceanTokens) }} /></p>
      </Modal>
    )
  }

  if (step === 'create') {
    const at = phase ? PHASES.indexOf(phase) : -1
    return (
      <Modal title={t('rental.title')} heading={t('rental.progress.heading', { name: serverName })} onClose={close} className="do-rental"
        footer={
          kept ? <button className="button" onClick={onClose}>{t('common.close')}</button>
          : failure ? (
            <>
              {failure.canWait && hasServer && address && <button className="button" onClick={() => void keepWaiting()}>{t('rental.failed.keepWaiting')}</button>}
              {hasServer && cleaning !== 'failed' && (
                <button className="button danger" disabled={cleaning === 'busy'} onClick={() => void cleanUp()}>
                  {cleaning === 'busy' ? t('rental.failed.cleaning') : t('rental.failed.cleanUp')}
                </button>
              )}
              {!hasServer && <button className="button primary" onClick={() => { setFailure(null); setStep('place') }}>{t('rental.failed.retry')}</button>}
            </>
          ) : <button className="button" onClick={() => setAsking(true)}>{t('rental.progress.stop')}</button>
        }
      >
        {progressBar}
        <ol className="do-progress" data-testid="do-progress">
          {PHASES.map((p, i) => {
            const state = i < at ? 'done' : i === at ? (failure ? 'failed' : 'current') : 'todo'
            return (
              <li key={p} data-state={state}>
                {state === 'current' && !kept ? <Spinner /> : <span className="do-dot" aria-hidden />}
                <span>{t(`rental.progress.${p}`)}</span>
              </li>
            )
          })}
        </ol>
        {address && <p className="muted small">{t('rental.progress.address', { url: address.url })}</p>}
        {!failure && !kept && <p className="muted small" role="status">{t('rental.progress.keepOpen')}</p>}
        {kept && address && (
          <p className="dialog-note" role="note"><span><Trans i18nKey="rental.stopAsk.kept" values={{ ip: address.ip }} components={{ droplets: external(LINKS.digitalOceanDroplets) }} /></span></p>
        )}
        {failure && !kept && (
          <div role="alert" className="do-failure">
            <strong>{t('rental.failed.heading')}</strong>
            <p>{failure.text}</p>
            {failure.detail && <p className="muted small">{failure.detail}</p>}
            {hasServer && cleaning !== 'failed' && <p>{t('rental.failed.created')}</p>}
            {cleaning === 'done' && <p>{t('rental.failed.cleaned')}</p>}
            {cleaning === 'failed' && (
              <p><Trans i18nKey="rental.failed.cleanFailed" components={{ droplets: external(LINKS.digitalOceanDroplets), firewalls: external(LINKS.digitalOceanFirewalls) }} /></p>
            )}
          </div>
        )}
      </Modal>
    )
  }

  if (step === 'place' && choice) {
    const price = formatPrice(choice.size.priceMonthly)
    return (
      <Modal title={t('rental.title')} heading={t('rental.place.heading')} onBack={() => setStep('token')} onClose={onClose} className="do-rental"
        footer={
          <>
            <button className="button" onClick={() => setStep('token')}>{t('rental.token.back')}</button>
            <button className="button primary" disabled={!serverName} onClick={() => void create()}>{t('rental.place.create', { price })}</button>
          </>
        }
      >
        {progressBar}
        <div className="rent-fields">
          <label className="field">
            <span>{t('rental.place.name')}</span>
            <input autoFocus value={name} maxLength={60} placeholder={t('settings.createServer.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('rental.place.template')}</span>
            <select value={template} onChange={(e) => setTemplate(isTemplate(e.target.value) ? e.target.value : 'gaming')}>
              {TEMPLATES.map((id) => <option key={id} value={id}>{t(`hosting.wizard.template.${id}.name`)}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          <span>{t('rental.place.region')}</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            {regions.map((r) => <option key={r.slug} value={r.slug}>{t('rental.place.regionOption', { name: r.name, price: formatPrice(r.size.priceMonthly) })}</option>)}
          </select>
          <small className="muted">{t('rental.place.regionHint')}</small>
        </label>
        <p className="do-size" data-testid="do-size">
          <Trans i18nKey="rental.place.size" values={{ memory: formatMemory(choice.size.memoryMb), vcpus: choice.size.vcpus, disk: choice.size.diskGb, price }} components={{ b: <strong /> }} />
        </p>
        <label className="checkbox">
          <input type="checkbox" checked={ssh} onChange={(e) => setSsh(e.target.checked)} />
          <span>
            {t('rental.place.ssh')}
            <br /><small className="muted">{t('rental.place.sshHint')}</small>
          </span>
        </label>
        <p className="muted small">{t('rental.place.note')}</p>
      </Modal>
    )
  }

  const failureNote = failure && (
    <div role="alert">
      <p className="error-text">{failure.text}</p>
      {failure.detail && <p className="muted small">{failure.detail}</p>}
    </div>
  )

  if ((step === 'token' || step === 'place') && oauth && !useToken) {
    return (
      <Modal title={t('rental.title')} heading={t('rental.connect.heading')} onBack={() => setStep('account')} onClose={onClose} className="do-rental"
        footer={
          <>
            <button className="button" onClick={() => setStep('account')}>{t('rental.token.back')}</button>
            {checking
              ? <button className="button" onClick={() => void bridge.cancel()}>{t('rental.connect.cancel')}</button>
              : <button className="button primary" onClick={() => void connect(true)}>{t('rental.connect.button')}</button>}
          </>
        }
      >
        {progressBar}
        <p>{t('rental.connect.intro')}</p>
        {checking && <p className="rent-progress" role="status"><Spinner /> {t('rental.connect.waiting')}</p>}
        {failureNote}
        <p className="muted small">
          <button className="link" onClick={() => { setFailure(null); setUseToken(true) }} disabled={checking}>{t('rental.connect.fallback')}</button>
        </p>
      </Modal>
    )
  }

  if (step === 'token' || step === 'place') {
    return (
      <Modal title={t('rental.title')} heading={t('rental.token.heading')} onBack={() => setStep('account')} onClose={onClose} className="do-rental"
        footer={
          <>
            <button className="button" onClick={() => (oauth ? setUseToken(false) : setStep('account'))}>{t('rental.token.back')}</button>
            <button className="button primary" disabled={!token.trim() || checking} onClick={() => void connect()}>
              {checking ? t('rental.token.checking') : t('rental.token.next')}
            </button>
          </>
        }
      >
        {progressBar}
        <p className="muted">{t('rental.token.intro')}</p>
        <ol className="rent-steps">
          <li><Trans i18nKey="rental.token.step1" components={{ tokens: external(LINKS.digitalOceanTokens), b: <strong /> }} /></li>
          <li><Trans i18nKey="rental.token.step2" components={{ b: <strong /> }} /></li>
          <li><Trans i18nKey="rental.token.step3" components={{ b: <strong /> }} /></li>
          <li><Trans i18nKey="rental.token.step4" components={{ b: <strong /> }} /></li>
        </ol>
        <label className="field">
          <span>{t('rental.token.label')}</span>
          <input type="password" autoComplete="off" spellCheck={false} value={token} placeholder={t('rental.token.placeholder')} maxLength={200}
            onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void connect()} />
        </label>
        {checking && <p className="rent-progress" role="status"><Spinner /> {t('rental.token.checking')}</p>}
        {failureNote}
      </Modal>
    )
  }

  return (
    <Modal title={t('rental.title')} heading={t('rental.account.heading')} onClose={onClose} className="do-rental"
      footer={
        <>
          <a className="button" href={LINKS.digitalOceanReferral} target="_blank" rel="noopener noreferrer">{t('rental.account.open')}</a>
          <button className="button primary" onClick={() => setStep('token')}>{t('rental.account.have')}</button>
        </>
      }
    >
      {progressBar}
      <p>{t('rental.account.intro')}</p>
      <p><Trans i18nKey="rental.account.cost" components={{ b: <strong /> }} /></p>
      <p>{t('rental.account.credit')}</p>
      <p className="dialog-note" role="note" data-testid="do-referral"><span>{t('rental.account.referral')}</span></p>
    </Modal>
  )
}
