// "Move this server": a guided flow. Back up → restore on the new computer → check the new address → send everyone there.
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { cleanServerUrl, probeServerKey } from '../../core/move'
import { LINKS } from '../../links'
import { desktop, type HostedServer } from '../../platform/desktop'
import { connectionFor, type ServerState } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { BackupMaker } from './BackupSection'

type Step = 'backup' | 'restore' | 'address' | 'done'
const STEPS: { id: Step }[] = [{ id: 'backup' }, { id: 'restore' }, { id: 'address' }, { id: 'done' }]

/** The copy hosted by this desktop app, if this is the computer the server runs on. */
function useLocalCopy(server: ServerState): HostedServer | null {
  const [hosted, setHosted] = useState<HostedServer | null>(null)
  useEffect(() => {
    let port = ''
    try {
      port = new URL(server.url).port
    } catch {
      return
    }
    desktop?.host.list().then((list) => setHosted((prev) => prev ?? list.find((h) => h.running && String(h.port) === port) ?? null)).catch(() => undefined)
  }, [server.url])
  return hosted
}

export function MoveServerDialog({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('backup')
  const [address, setAddress] = useState('')
  const [checked, setChecked] = useState<'idle' | 'checking' | 'same' | 'other' | 'unreachable'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const local = useLocalCopy(server)
  const url = cleanServerUrl(address)
  const index = STEPS.findIndex((s) => s.id === step)

  async function check() {
    if (!url) return
    setChecked('checking')
    const key = await probeServerKey(url)
    setChecked(key === null ? 'unreachable' : key === server.key ? 'same' : 'other')
  }

  async function move() {
    if (!url || checked !== 'same') return
    setBusy(true)
    setError(null)
    try {
      await connectionFor(server.key)?.request('server.move', { url })
      setStep('done')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      {index > 0 && step !== 'done' && <button className="button ghost" onClick={() => setStep(STEPS[index - 1].id)}>{t('common.back')}</button>}
      {step === 'backup' && <button className="button primary" onClick={() => setStep('restore')}>{t('settings.move.haveBackup')}</button>}
      {step === 'restore' && <button className="button primary" onClick={() => setStep('address')}>{t('settings.move.running')}</button>}
      {step === 'address' && (
        <button className="button primary" disabled={checked !== 'same' || busy} onClick={() => void move()}>
          {busy ? <Spinner /> : t('settings.move.moveEveryone')}
        </button>
      )}
      {step === 'done' && <button className="button primary" onClick={onClose}>{t('common.close')}</button>}
    </>
  )

  return (
    <Modal title={t('settings.backup.moveTitle')} onClose={onClose} footer={footer} className="move-dialog">
      <ol className="move-steps" aria-label={t('settings.move.steps')}>
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < index ? 'past' : i === index ? 'current' : ''} aria-current={i === index ? 'step' : undefined}>
            <span className="move-step-number" aria-hidden>{i < index ? '✓' : i + 1}</span>
            <span>{t(`settings.move.step.${s.id}`)}</span>
          </li>
        ))}
      </ol>

      {step === 'backup' && (
        <div className="move-pane">
          <p><Trans i18nKey="settings.move.backupFirst" values={{ name: server.name }} components={{ b: <strong /> }} /></p>
          <BackupMaker server={server} onMade={() => setStep('restore')} />
        </div>
      )}

      {step === 'restore' && (
        <div className="move-pane">
          <p>{t('settings.move.copyFile')}</p>
          <section className="guide-option">
            <h4>{t('settings.move.withApp')}</h4>
            <ol>
              <li><Trans i18nKey="settings.move.app1" components={{ a: <a href={LINKS.windowsInstaller} /> }} /></li>
              <li><Trans i18nKey="settings.move.app2" components={{ b: <strong /> }} /></li>
              <li>{t('settings.move.app3')}</li>
            </ol>
          </section>
          <section className="guide-option">
            <h4>{t('settings.move.withCli')}</h4>
            <pre className="move-command">iskra-server restore my-server.iskrabackup my-server{'\n'}iskra-server my-server</pre>
            <p className="muted"><Trans i18nKey="settings.move.checkPort" components={{ code: <code /> }} /></p>
          </section>
          <p className="muted">
            <Trans i18nKey="settings.move.internet" components={{ b: <strong /> }} />
          </p>
        </div>
      )}

      {step === 'address' && (
        <div className="move-pane">
          <p>{t('settings.move.where')}</p>
          <label className="field">
            <span>{t('settings.move.newAddress')}</span>
            <div className="copy-row">
              <input value={address} placeholder={t('common.example', { value: 'https://chat.example.com' })} autoFocus inputMode="url" autoCapitalize="off" spellCheck={false}
                onChange={(e) => { setAddress(e.target.value); setChecked('idle') }}
                onKeyDown={(e) => e.key === 'Enter' && void check()} />
              <button className="button" disabled={!url || checked === 'checking'} onClick={() => void check()}>
                {checked === 'checking' ? <Spinner /> : t('settings.move.check')}
              </button>
            </div>
          </label>
          {address && !url && <p className="error-text">{t('settings.move.badAddress')}</p>}
          {checked === 'same' && <p className="move-ok" role="status">✓ {t('settings.move.same')}</p>}
          {checked === 'other' && <p className="error-text">{t('settings.move.other')}</p>}
          {checked === 'unreachable' && (
            <p className="error-text">{t('settings.move.unreachable')}</p>
          )}
          <p className="muted">{t('settings.move.howItWorks')}</p>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}

      {step === 'done' && (
        <div className="move-pane">
          <p className="move-ok">✓ <Trans i18nKey="settings.move.sending" values={{ url: url ?? '' }} components={{ b: <strong /> }} /></p>
          <p className="muted">
            {t('settings.move.cancelHint')}{' '}<code>iskra-server move &lt;folder&gt; --cancel</code>.
          </p>
          {local && desktop && (
            <div className="settings-danger">
              <div>
                <strong>{t('settings.move.oldHere')}</strong>
                <p className="muted">{t('settings.move.oldHereHint')}</p>
              </div>
              <button className="button danger-outline" disabled={stopped}
                onClick={() => void desktop!.host.stop(local.id).then(() => setStopped(true))}>
                {stopped ? t('settings.move.stopped') : t('settings.move.stopOld')}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
