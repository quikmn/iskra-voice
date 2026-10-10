// "Move this server": a guided flow. Back up → restore on the new computer → check the new address → send everyone there.
import { useEffect, useState } from 'react'
import { cleanServerUrl, probeServerKey } from '../../core/move'
import { LINKS } from '../../links'
import { desktop, type HostedServer } from '../../platform/desktop'
import { connectionFor, type ServerState } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { BackupMaker } from './BackupSection'

type Step = 'backup' | 'restore' | 'address' | 'done'
const STEPS: { id: Step; label: string }[] = [
  { id: 'backup', label: 'Back up' },
  { id: 'restore', label: 'Restore' },
  { id: 'address', label: 'Switch' },
  { id: 'done', label: 'Done' },
]

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
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      {index > 0 && step !== 'done' && <button className="button ghost" onClick={() => setStep(STEPS[index - 1].id)}>Back</button>}
      {step === 'backup' && <button className="button primary" onClick={() => setStep('restore')}>I have a backup</button>}
      {step === 'restore' && <button className="button primary" onClick={() => setStep('address')}>It's running there</button>}
      {step === 'address' && (
        <button className="button primary" disabled={checked !== 'same' || busy} onClick={() => void move()}>
          {busy ? <Spinner /> : 'Move everyone'}
        </button>
      )}
      {step === 'done' && <button className="button primary" onClick={onClose}>Close</button>}
    </>
  )

  return (
    <Modal title="Move this server" onClose={onClose} footer={footer} className="move-dialog">
      <ol className="move-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < index ? 'past' : i === index ? 'current' : ''} aria-current={i === index ? 'step' : undefined}>
            <span className="move-step-number" aria-hidden>{i < index ? '✓' : i + 1}</span>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>

      {step === 'backup' && (
        <div className="move-pane">
          <p>First, make a backup of <strong>{server.name}</strong>. It includes everything, and its key, so the new copy is the same server.</p>
          <BackupMaker server={server} onMade={() => setStep('restore')} />
        </div>
      )}

      {step === 'restore' && (
        <div className="move-pane">
          <p>Copy the backup file to the new computer, then restore it there:</p>
          <section className="guide-option">
            <h4>With the Iskra app</h4>
            <ol>
              <li>Install Iskra (<a href={LINKS.windowsInstaller}>download</a>) and open it.</li>
              <li>Click <strong>Create a server</strong>, then <strong>Restore from a backup</strong>, and pick the file.</li>
              <li>Enter the passphrase. The server starts right away.</li>
            </ol>
          </section>
          <section className="guide-option">
            <h4>On a VPS or with the command line</h4>
            <pre className="move-command">iskra-server restore my-server.iskrabackup my-server{'\n'}iskra-server my-server</pre>
            <p className="muted">Check the port and <code>PublicUrl</code> in <code>server.json</code> if the new machine's address is different.</p>
          </section>
          <p className="muted">
            For friends outside your home network, turn on <strong>Open to the internet</strong> on the new copy (or set up HTTPS) before
            you continue.
          </p>
        </div>
      )}

      {step === 'address' && (
        <div className="move-pane">
          <p>Where does the new copy run? Use the address friends will connect to.</p>
          <label className="field">
            <span>New address</span>
            <div className="copy-row">
              <input value={address} placeholder="https://chat.example.com" autoFocus inputMode="url" autoCapitalize="off" spellCheck={false}
                onChange={(e) => { setAddress(e.target.value); setChecked('idle') }}
                onKeyDown={(e) => e.key === 'Enter' && void check()} />
              <button className="button" disabled={!url || checked === 'checking'} onClick={() => void check()}>
                {checked === 'checking' ? <Spinner /> : 'Check'}
              </button>
            </div>
          </label>
          {address && !url && <p className="error-text">That doesn't look like an address. Try https://chat.example.com or http://192.168.1.20:47070.</p>}
          {checked === 'same' && <p className="move-ok" role="status">✓ That's this server, running at its new address.</p>}
          {checked === 'other' && <p className="error-text">A different server answers there. Restore this server's backup on it first.</p>}
          {checked === 'unreachable' && (
            <p className="error-text">Couldn't reach it from here. Is it running, and can this device reach that address?</p>
          )}
          <p className="muted">
            When you move everyone, their apps switch to the new address by themselves (they check that it's signed by this server).
            This copy then stops taking messages. Keep it running for a few days, so people who are offline now get the news.
          </p>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}

      {step === 'done' && (
        <div className="move-pane">
          <p className="move-ok">✓ Everyone is being sent to <strong>{url}</strong>.</p>
          <p className="muted">
            Share new invite links from the new address. If you change your mind, cancel the move from the old computer with{' '}
            <code>iskra-server move &lt;folder&gt; --cancel</code>.
          </p>
          {local && desktop && (
            <div className="settings-danger">
              <div>
                <strong>The old copy runs on this computer</strong>
                <p className="muted">Stop it once everyone has moved over. Its folder stays where it is.</p>
              </div>
              <button className="button danger-outline" disabled={stopped}
                onClick={() => void desktop!.host.stop(local.id).then(() => setStopped(true))}>
                {stopped ? 'Stopped' : 'Stop old copy'}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
