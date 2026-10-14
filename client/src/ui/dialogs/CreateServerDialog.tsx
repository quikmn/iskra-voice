import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { t } from '../../i18n'
import { errorMessage } from '../../i18n/errors'
import { parseInvite } from '../../core/invite'
import { desktop, type HostedServer, type ServerTemplateInfo, type TemplateChannelInfo } from '../../platform/desktop'
import { noteHosted, setKeepRunning } from '../../state/hosting'
import { acceptInvite, useApp } from '../../state/store'
import { RestoreServer } from './RestoreServer'
import { DigitalOceanDialog } from './DigitalOceanDialog'
import { InviteDialog } from './InviteDialog'
import '../settings/backup.css'
import './CreateServerDialog.css'
import { Modal, Spinner } from '../bits'
import { TemplatePreview } from '../templates/TemplatePreview'
import { ChannelKindIcon } from '../ChannelKindIcon'
import { appUrl } from '../format'

/** Where the desktop app keeps hosted servers (desktop/src/platform.ts). */
function hostFolder(): string {
  if (desktop?.platform === 'darwin') return '~/Library/Application Support/Iskra/Servers'
  return desktop?.platform === 'win32' ? 'Documents\\Iskra\\Servers' : '~/Documents/Iskra/Servers'
}

/** The one-time network prompt the OS shows when the server first listens. */
function firewallNote(): string | null {
  if (desktop?.platform === 'win32') return t('settings.createServer.firewallWindows')
  if (desktop?.platform === 'darwin') return t('settings.createServer.firewallMac')
  return null
}

const ShieldIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </svg>
)

const KNOWN = ['gaming', 'friends', 'tabletop', 'empty'] as const
type Known = (typeof KNOWN)[number]
const known = (id: string): Known | undefined => KNOWN.find((k) => k === id)

/** The built-in templates in the app's language; your own ones as the server describes them. */
export function templateText(template: ServerTemplateInfo): { name: string; description: string } {
  const k = known(template.id)
  return k
    ? { name: t(`hosting.wizard.template.${k}.name`), description: t(`hosting.wizard.template.${k}.description`) }
    : { name: template.name, description: template.description }
}

/** Desktop only: start a server on this computer and become its owner. */
export function CreateServerDialog({ onClose }: { onClose: () => void }) {
  const [restoring, setRestoring] = useState(false)
  const [renting, setRenting] = useState(false)
  if (restoring) return <RestoreServer onBack={() => setRestoring(false)} onClose={onClose} />
  if (renting) return <DigitalOceanDialog onClose={onClose} />
  return <NewServer onClose={onClose} onRestore={desktop?.host.pickBackup ? () => setRestoring(true) : undefined} onRent={desktop?.digitalOcean ? () => setRenting(true) : undefined} />
}

type Step = 'name' | 'template' | 'starting' | 'done'

/** The setup wizard: a name, a starting point, then it's running and you invite friends. */
function NewServer({ onClose, onRestore, onRent }: { onClose: () => void; onRestore?: () => void; onRent?: () => void }) {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('name')
  const [name, setName] = useState('')
  const [templates, setTemplates] = useState<ServerTemplateInfo[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  const [fromFile, setFromFile] = useState<{ fileName: string; template: ServerTemplateInfo } | null>(null)
  const [hosted, setHosted] = useState<HostedServer | null>(null)
  const [serverKey, setServerKey] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const joined = useApp((s) => (serverKey ? s.servers[serverKey] : undefined))

  useEffect(() => {
    let cancelled = false
    desktop?.host.templates?.().then((list) => {
      if (cancelled || list.length === 0) return
      setTemplates(list)
      setPicked((p) => p ?? list[0].id)
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  async function create() {
    if (!desktop || !trimmed || step === 'starting') return
    setStep('starting')
    setError(null)
    try {
      const server = await desktop.host.create(trimmed, appUrl(), templates.length > 0 ? picked : null)
      const invite = server?.ownerInvite ? parseInvite(server.ownerInvite) : null
      if (!server || !invite) throw new Error(t('settings.createServer.noOwnerLink'))
      noteHosted(server)
      // You're on the same computer, so connect over localhost (it never changes).
      acceptInvite({ ...invite, serverUrl: server.localUrl })
      setHosted(server)
      setServerKey(invite.serverKey)
      setStep('done')
    } catch (e) {
      setError(errorMessage(e))
      setStep(templates.length > 0 ? 'template' : 'name')
    }
  }

  async function pickFile() {
    setError(null)
    try {
      const result = await desktop?.host.pickTemplate?.()
      if (!result) return
      if ('error' in result) {
        setError(t('templates.file.invalid', { error: result.error }))
        return
      }
      setFromFile(result)
      setPicked(result.template.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const choices = fromFile ? [...templates, fromFile.template] : templates
  const selected = choices.find((c) => c.id === picked) ?? null

  const next = () => {
    if (!trimmed) return
    if (templates.length > 0) setStep('template')
    else void create()
  }

  if (inviting && joined?.me) return <InviteDialog server={joined} onClose={onClose} />

  const steps: Step[] = templates.length > 0 ? ['name', 'template', 'done'] : ['name', 'done']
  const current = step === 'starting' ? 'done' : step
  const progress = (
    <ol className="wizard-steps" aria-label={t('hosting.wizard.steps')}>
      {steps.map((s, i) => (
        <li key={s} className={s === current ? 'current' : steps.indexOf(current) > i ? 'done' : ''} aria-current={s === current ? 'step' : undefined}>
          {t(s === 'name' ? 'hosting.wizard.stepName' : s === 'template' ? 'hosting.wizard.stepTemplate' : 'hosting.wizard.stepDone')}
        </li>
      ))}
    </ol>
  )

  if (step === 'starting') {
    return (
      <Modal title={t('settings.createServer.title')} onClose={() => undefined}>
        {progress}
        <div className="wizard-starting" role="status">
          <Spinner />
          <p>{t('hosting.wizard.starting')}</p>
          <p className="muted">{t('hosting.wizard.startingSlow')}</p>
        </div>
      </Modal>
    )
  }

  if (step === 'done' && hosted) {
    return (
      <Modal
        title={t('settings.createServer.title')}
        heading={t('hosting.wizard.doneTitle', { name: hosted.name })}
        onClose={onClose}
        footer={
          <>
            <button className="button" onClick={onClose}>{t('hosting.wizard.finish')}</button>
            <button className="button primary" disabled={!joined?.me} onClick={() => setInviting(true)}>
              {joined?.me ? t('hosting.wizard.inviteNow') : t('hosting.wizard.connecting')}
            </button>
          </>
        }
      >
        {progress}
        <p>{t('hosting.wizard.doneIntro')}</p>
        {desktop?.host.keepRunning && <KeepRunning server={hosted} onChange={setHosted} />}
        <p className="muted"><Trans i18nKey="hosting.wizard.nextInternet" components={{ b: <strong /> }} /></p>
      </Modal>
    )
  }

  if (step === 'template') {
    return (
      <Modal
        title={t('settings.createServer.title')}
        heading={t('hosting.wizard.templateTitle')}
        onBack={() => setStep('name')}
        onClose={onClose}
        wide
        footer={
          <>
            <button className="button" onClick={() => setStep('name')}>{t('hosting.wizard.back')}</button>
            <button className="button primary" disabled={!picked} onClick={() => void create()}>{t('common.create')}</button>
          </>
        }
      >
        {progress}
        <p className="muted">{t('hosting.wizard.templateIntro')}</p>
        <div className="template-grid" role="radiogroup" aria-label={t('hosting.wizard.templates')}>
          {choices.map((template) => (
            <TemplateCard key={template.id} template={template} selected={picked === template.id} onPick={() => setPicked(template.id)}
              fileName={template.id === fromFile?.template.id ? fromFile.fileName : undefined} />
          ))}
        </div>
        {desktop?.host.pickTemplate && (
          <p className="muted template-file">
            <button className="link" onClick={() => void pickFile()}>{t('templates.file.pick')}</button> {t('templates.file.hint')}
          </p>
        )}
        {selected && <TemplatePreview template={selected} />}
        {error && <p className="error-text">{error}</p>}
      </Modal>
    )
  }

  return (
    <Modal
      title={t('settings.createServer.title')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!trimmed} onClick={next}>
            {templates.length > 0 ? t('hosting.wizard.next') : t('common.create')}
          </button>
        </>
      }
    >
      {templates.length > 0 && progress}
      <p className="muted">{t('settings.createServer.intro', { folder: hostFolder() })}</p>
      <label className="field">
        <span>{t('settings.createServer.name')}</span>
        <input autoFocus value={name} maxLength={60} placeholder={t('settings.createServer.namePlaceholder')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && next()} />
      </label>
      {firewallNote() && (
        <p className="dialog-note" role="note">
          <ShieldIcon />
          <span>{firewallNote()}</span>
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      {onRestore && (
        <p className="muted restore-link">
          {t('settings.createServer.moving')} <button className="link" onClick={onRestore}>{t('settings.createServer.restore')}</button>
        </p>
      )}
      {onRent && (
        <p className="muted restore-link">
          {t('rental.createLink')} <button className="link" onClick={onRent}>{t('rental.createButton')}</button>
        </p>
      )}
    </Modal>
  )
}

function ChannelPreview({ channel }: { channel: TemplateChannelInfo }) {
  const { t } = useTranslation()
  return (
    <li>
      <ChannelKindIcon kind={channel.kind} size={13} />
      <span>{channel.name}</span>
      {channel.userLimit > 0 && <small className="muted">{t('hosting.wizard.upTo', { count: channel.userLimit })}</small>}
    </li>
  )
}

function TemplateCard({ template, selected, onPick, fileName }: { template: ServerTemplateInfo; selected: boolean; onPick: () => void; fileName?: string }) {
  const { t } = useTranslation()
  const text = templateText(template)
  const groups = [...(template.channels.length > 0 ? [{ name: null as string | null, channels: template.channels }] : []), ...template.categories]
  return (
    <button type="button" role="radio" aria-checked={selected} className={`template-card ${selected ? 'selected' : ''}`} onClick={onPick} data-template={template.id}>
      <strong>{text.name}</strong>
      <span className="template-description">{fileName ? t('templates.file.from', { file: fileName }) : text.description}</span>
      <div className="template-preview" aria-hidden>
        {groups.map((group, i) => (
          <div key={i}>
            {group.name && <span className="template-category">{group.name}</span>}
            <ul>{group.channels.map((c, j) => <ChannelPreview key={j} channel={c} />)}</ul>
          </div>
        ))}
      </div>
      {template.roles.length > 0 && <small className="muted">{t('hosting.wizard.roles', { roles: template.roles.join(', ') })}</small>}
      {template.rules && <small className="muted">{t('hosting.wizard.withRules')}</small>}
    </button>
  )
}

/** "Keep my server running": one tickbox for a server on this computer. */
export function KeepRunning({ server, onChange }: { server: HostedServer; onChange?: (server: HostedServer) => void }) {
  const { t } = useTranslation()
  const [on, setOn] = useState(!!server.keepRunning)
  const [busy, setBusy] = useState(false)
  useEffect(() => setOn(!!server.keepRunning), [server.keepRunning])
  async function change(value: boolean) {
    setBusy(true)
    setOn(value)
    try {
      await setKeepRunning(server.id, value)
      onChange?.({ ...server, keepRunning: value })
    } catch {
      setOn(!value)
    } finally {
      setBusy(false)
    }
  }
  return (
    <label className="checkbox keep-running">
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void change(e.target.checked)} />
      <span>
        {t('hosting.keepRunning.label')}
        <br /><small className="muted">{t('hosting.keepRunning.hint')}</small>
      </span>
    </label>
  )
}
