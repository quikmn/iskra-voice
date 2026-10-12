// "Open to the internet", part two: what Iskra found out about the connection, how to forward the ports by hand
// (with a prompt for an AI assistant), and honest options when the connection is shared (CGNAT).
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { HostStatus } from '../../core/protocol'
import { LINKS } from '../../links'
import { aiPrompt, cgnatAdvice, forwardRows, lanHost, routerPage } from '../../state/hosting'

/** Plain-words findings, all from the router's own answers and this computer: no outside service is asked. */
export function Findings({ status }: { status: HostStatus }) {
  const { t } = useTranslation()
  const ip = status.publicIp ?? ''
  const nat = status.nat ?? (status.cgnat ? 'cgnat' : null)
  const natLine =
    nat === 'public' ? t('hosting.reach.natPublic', { ip })
    : nat === 'cgnat' ? t('hosting.reach.natCgnat', { ip })
    : nat === 'private' ? t('hosting.reach.natPrivate', { ip })
    : status.router.state === 'searching' ? null
    : t('hosting.reach.natUnknown')
  const voiceTcp = status.ports.find((p) => p.name === 'voice-tcp')
  const voiceUdp = status.ports.find((p) => p.name === 'voice-udp')
  const refused = status.router.state === 'found' && status.ports.some((p) => p.state === 'failed')
  return (
    <div className="internet-findings" data-testid="host-findings" data-nat={nat ?? 'unknown'}>
      <strong>{t('hosting.reach.title')}</strong>
      <ul>
        {natLine && <li className={nat === 'public' ? 'good' : 'warn'}>{natLine}</li>}
        {refused && <li className="warn">{t('hosting.reach.routerRefused')}</li>}
        {status.reachable === 'verified' && <li className="good">{t('hosting.reach.verified')}</li>}
        {status.router.model && <li>{t('hosting.reach.router', { model: status.router.model })}</li>}
        {voiceTcp && voiceUdp && <li>{t('hosting.reach.voiceNote', { tcp: voiceTcp.external, udp: voiceUdp.external })}</li>}
      </ul>
    </div>
  )
}

/** Step by step: the router page, the exact ports, this computer's address, and a prompt for an AI assistant. */
export function ForwardHelp({ status, startOpen }: { status: HostStatus; startOpen: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(startOpen)
  const [asking, setAsking] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [copied, setCopied] = useState(false)
  const rows = forwardRows(status)
  const lan = status.lanIp ?? lanHost(status)
  const page = routerPage(status)

  function showPrompt() {
    setPrompt(aiPrompt(status))
    setCopied(false)
    setAsking(true)
  }

  async function copy() {
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
  }

  return (
    <div className="internet-callout" data-testid="manual-forwards">
      <div className="callout-head">
        <strong>{t('hosting.forward.title')}</strong>
        <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('hosting.forward.hide') : t('hosting.forward.open')}</button>
      </div>
      {open && (
        <>
          <ol className="forward-steps">
            <li>
              {page
                ? <Trans i18nKey="hosting.forward.step1" values={{ url: page }} components={{ page: <a href={page} target="_blank" rel="noopener noreferrer" /> }} />
                : t('hosting.forward.step1NoGateway')}
            </li>
            <li>{t('hosting.forward.step2')}</li>
            <li>{lan ? <Trans i18nKey="hosting.forward.step3" values={{ ip: lan }} components={{ code: <code /> }} /> : t('hosting.forward.step3NoIp')}</li>
            <li><Trans i18nKey="hosting.forward.step4" components={{ b: <strong /> }} /></li>
          </ol>
          <table className="forward-table">
            <thead>
              <tr><th>{t('settings.internet.outside')}</th><th>{t('settings.internet.toPort')}</th><th>{t('settings.internet.type')}</th><th>{t('settings.internet.for')}</th></tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={`${f.protocol}-${f.external}`}>
                  <td>{f.external}</td><td>{f.internal}</td><td>{f.protocol}</td><td>{f.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="forward-facts">
            {lan && <li>{t('hosting.reach.lanIp', { ip: lan })}</li>}
            {status.gateway && <li>{t('hosting.reach.gateway', { ip: status.gateway })}</li>}
            {status.router.model && <li>{t('hosting.reach.router', { model: status.router.model })}</li>}
          </ul>
          {status.nat === 'private' && <p>{t('hosting.forward.doubleNat')}</p>}
          {status.os && <p className="muted">{t(`hosting.forward.firewall.${status.os}`)}</p>}
          <p className="muted">{t('settings.internet.upnp')}</p>
          {!asking ? (
            <button className="button" onClick={showPrompt}>{t('hosting.forward.ai.button')}</button>
          ) : (
            <div className="ai-prompt" data-testid="ai-prompt">
              <strong>{t('hosting.forward.ai.title')}</strong>
              <p className="muted">{t('hosting.forward.ai.intro')}</p>
              <label className="field">
                <span>{t('hosting.forward.ai.label')}</span>
                <textarea rows={10} value={prompt} maxLength={4000} onChange={(e) => {
                  setPrompt(e.target.value)
                  setCopied(false)
                }} />
              </label>
              <button className="button primary" onClick={() => void copy()}>{copied ? t('hosting.forward.ai.copied') : t('hosting.forward.ai.copy')}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * When ports can't help: what to do, easiest first. Room for one more option later ("connect without port
 * forwarding", a peer-to-peer tunnel being researched): it goes in OPTIONS, before the VPS.
 */
export function CgnatHelp({ status }: { status: HostStatus }) {
  const { t } = useTranslation()
  const advice = cgnatAdvice(status)
  if (!advice) return null
  const shared = advice === 'shared'
  const OPTIONS = [
    shared ? <Trans key="check" i18nKey="hosting.cgnat.checkShared" values={{ ip: status.publicIp ?? '' }} components={{ b: <strong /> }} />
      : <Trans key="check" i18nKey="hosting.cgnat.check" components={{ b: <strong /> }} />,
    <Trans key="isp" i18nKey="hosting.cgnat.isp" components={{ b: <strong /> }} />,
    <Trans key="friend" i18nKey="hosting.cgnat.friend" components={{ b: <strong /> }} />,
    <span key="vps">
      <Trans i18nKey="hosting.cgnat.vps" components={{ b: <strong /> }} />{' '}
      <a href={`${LINKS.hostingGuide}#on-a-linux-vps-with-systemd`} target="_blank" rel="noopener noreferrer">{t('hosting.cgnat.vpsLink')}</a>
    </span>,
  ]
  return (
    <div className={`internet-callout ${shared ? 'warn' : ''}`} data-testid="cgnat-help">
      <strong>{shared ? t('hosting.cgnat.titleShared') : t('hosting.cgnat.title')}</strong>
      <p>{shared ? t('hosting.cgnat.explain') : t('hosting.cgnat.explainMaybe')}</p>
      <ol className="cgnat-options">{OPTIONS.map((option, i) => <li key={i}>{option}</li>)}</ol>
    </div>
  )
}
