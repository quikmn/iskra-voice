// My settings → Bots on this PC (desktop app only): pick a gallery bot or a folder, connect it to a server with a bot
// invite, and the desktop app runs it (desktop/src/bots.ts) with start/stop, autostart and a log.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { desktop, type GalleryBotInfo, type PcBot } from '../../platform/desktop'
import { botLight, createBotInvite, inviteServers, looksLikeBotInvite, problemKey } from '../../state/pcBots'
import { useApp } from '../../state/store'
import { useStreamerMode } from '../../state/streamer'
import { appUrl } from '../format'
import './pcBots.css'

const camel = (id: string) => id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())

export function PcBotsSection() {
  const { t } = useTranslation()
  const bridge = desktop?.bots
  const [gallery, setGallery] = useState<GalleryBotInfo[]>([])
  const [bots, setBots] = useState<PcBot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [trust, setTrust] = useState(false)

  const refresh = useCallback(() => {
    void bridge?.list().then(setBots, () => setBots([]))
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    void bridge.gallery().then(setGallery, () => undefined)
    refresh()
    return bridge.onChange(refresh)
  }, [bridge, refresh])

  if (!bridge) return null

  const run = async (work: () => Promise<unknown>) => {
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(errorMessage(e))
    }
    refresh()
  }

  const addGallery = (g: GalleryBotInfo) => run(async () => {
    const added = await bridge.add(g.id)
    if (added) setNote(t('pcBots.added', { name: added.name }))
  })
  const addFolder = () => run(async () => {
    const added = await bridge.add(null)
    if (added) setNote(t('pcBots.added', { name: added.name }))
  })

  return (
    <section className="settings-section pc-bots" aria-labelledby="pc-bots-title">
      <h2 id="pc-bots-title">{t('settings.sections.pcBots')}</h2>
      <p className="muted">{t('pcBots.intro')}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {note && <p className="muted" role="status">{note}</p>}

      <h3 className="h4">{t('pcBots.mine')}</h3>
      {bots === null ? null : bots.length === 0 ? (
        <p className="muted">{t('pcBots.empty')}</p>
      ) : (
        <ul className="pc-bot-list">
          {bots.map((bot) => <BotCard key={bot.id} bot={bot} info={gallery.find((g) => g.id === bot.gallery)} run={run} />)}
        </ul>
      )}

      <h3 className="h4">{t('pcBots.galleryTitle')}</h3>
      <p className="muted">{t('pcBots.galleryIntro')}</p>
      <ul className="pc-bot-gallery">
        {gallery.map((g) => (
          <li key={g.id} className="pc-bot-gallery-item">
            <div>
              <strong>{g.name}</strong>
              <p className="muted">{t(`pcBots.gallery.${camel(g.id)}`, { defaultValue: t('pcBots.gallery.other') })}</p>
              {g.readAll && <small className="muted">{t('pcBots.needsReadAll')}</small>}
              {g.voice && <small className="muted">{t('pcBots.needsVoice')}</small>}
            </div>
            <button className="button" onClick={() => void addGallery(g)} aria-label={`${t('pcBots.add')}: ${g.name}`}>{t('pcBots.add')}</button>
          </li>
        ))}
      </ul>

      <h3 className="h4">{t('pcBots.folder.title')}</h3>
      <p className="pc-bot-warning" role="note">{t('pcBots.folder.warning')}</p>
      <div className="copy-row">
        <label className="checkbox">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          <span>{t('pcBots.folder.trust')}</span>
        </label>
        <button className="button" disabled={!trust} onClick={() => void addFolder()}>{t('pcBots.folder.pick')}</button>
      </div>
      <p><a href="https://iskra.foo/docs/bots" target="_blank" rel="noreferrer">{t('pcBots.docs')}</a></p>
    </section>
  )
}

function BotCard({ bot, info, run }: { bot: PcBot; info: GalleryBotInfo | undefined; run: (work: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useTranslation()
  const bridge = desktop!.bots!
  const [showLog, setShowLog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const light = botLight(bot)
  const problem = problemKey(bot.state === 'failed' ? bot.problem : null)
  const running = bot.state === 'starting' || bot.state === 'running'

  const start = () => (bot.needsInvite ? setConnecting(true) : void run(() => bridge.start(bot.id)))

  return (
    <li className="pc-bot" data-bot={bot.id}>
      <div className="pc-bot-head">
        <span className={`pc-bot-light ${light}`} aria-hidden />
        <div className="pc-bot-title">
          <strong>{bot.name}</strong>
          <small className="muted">{bot.kind === 'gallery' ? `${t('pcBots.galleryTitle')}: ${info?.name ?? bot.gallery}` : `${t('pcBots.folder.label')}: ${bot.folder}`}</small>
        </div>
        <span className="pc-bot-state" role="status">{t(`pcBots.state.${light}`)}</span>
      </div>
      {problem && <p className="error-text">{problem.key === 'exit' ? t('pcBots.problem.exit', { code: problem.code }) : t(`pcBots.problem.${problem.key}`)}</p>}
      <div className="pc-bot-actions">
        {running
          ? <button className="button" onClick={() => void run(() => bridge.stop(bot.id))}>{t('pcBots.stop')}</button>
          : <button className="button primary" onClick={start}>{t('pcBots.start')}</button>}
        <button className="button" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>{showLog ? t('pcBots.hideLog') : t('pcBots.log')}</button>
        <button className="button" aria-expanded={showSettings} onClick={() => setShowSettings(!showSettings)}>{showSettings ? t('pcBots.hideSettings') : t('pcBots.showSettings')}</button>
        <button className="button" onClick={() => void bridge.openFolder(bot.id)}>{t('pcBots.openFolder')}</button>
        {confirmRemove ? (
          <>
            <span className="muted pc-bot-confirm">{t(bot.kind === 'gallery' ? 'pcBots.removeConfirmGallery' : 'pcBots.removeConfirmFolder', { name: bot.name })}</span>
            <button className="button danger" onClick={() => void run(() => bridge.remove(bot.id))}>{t('common.remove')}</button>
            <button className="button" onClick={() => setConfirmRemove(false)}>{t('common.cancel')}</button>
          </>
        ) : (
          <button className="button danger-outline" onClick={() => setConfirmRemove(true)}>{t('common.remove')}</button>
        )}
      </div>
      {connecting && !running && <ConnectPanel bot={bot} info={info} onDone={() => setConnecting(false)} run={run} />}
      {showSettings && <BotSettings bot={bot} info={info} onNewInvite={() => setConnecting(true)} />}
      {showLog && <BotLog bot={bot} />}
    </li>
  )
}

/** A bot invite for the bot: made here on a server where you're an admin, or pasted. Then the bot starts with it. */
function ConnectPanel({ bot, info, onDone, run }: { bot: PcBot; info: GalleryBotInfo | undefined; onDone: () => void; run: (work: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useTranslation()
  const bridge = desktop!.bots!
  const servers = useApp((s) => s.servers)
  const choices = inviteServers(servers)
  const [serverKey, setServerKey] = useState(choices[0]?.key ?? '')
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const streamer = useStreamerMode()
  const chosen = choices.find((s) => s.key === serverKey) ?? choices[0]

  const startWith = (invite: () => Promise<string>) => {
    setBusy(true)
    void run(async () => {
      const link = await invite()
      await bridge.start(bot.id, link)
      onDone()
    }).finally(() => setBusy(false))
  }

  return (
    <div className="pc-bot-connect">
      <strong>{t('pcBots.invite.title')}</strong>
      <p className="muted">{t('pcBots.invite.intro')}</p>
      {chosen ? (
        <div className="copy-row">
          <label>
            <span className="sr-only">{t('pcBots.invite.server')}</span>
            <select aria-label={t('pcBots.invite.server')} value={chosen.key} onChange={(e) => setServerKey(e.target.value)}>
              {choices.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </label>
          <button className="button primary" disabled={busy}
            onClick={() => startWith(() => createBotInvite(chosen, { readAll: info?.readAll ?? false, voice: info?.voice ?? false }, appUrl(chosen.appUrl)))}>
            {t('pcBots.invite.create')}
          </button>
        </div>
      ) : (
        <p className="muted">{t('pcBots.invite.none')}</p>
      )}
      <form className="copy-row" onSubmit={(e) => {
        e.preventDefault()
        if (looksLikeBotInvite(pasted)) startWith(async () => pasted.trim())
      }}>
        <input type={streamer ? 'password' : 'text'} aria-label={t('pcBots.invite.pasteLabel')} placeholder={t('pcBots.invite.paste')} value={pasted}
          onChange={(e) => setPasted(e.target.value)} autoComplete="off" spellCheck={false} />
        <button className="button" disabled={busy || !looksLikeBotInvite(pasted)}>{t('pcBots.invite.startWith')}</button>
      </form>
      {pasted.trim() !== '' && !looksLikeBotInvite(pasted) && <p className="error-text">{t('pcBots.invite.bad')}</p>}
      <button className="button small" onClick={onDone}>{t('common.cancel')}</button>
    </div>
  )
}

function BotSettings({ bot, info, onNewInvite }: { bot: PcBot; info: GalleryBotInfo | undefined; onNewInvite: () => void }) {
  const { t } = useTranslation()
  const bridge = desktop!.bots!
  const [name, setName] = useState(bot.name)
  // Secret settings start empty: the page never gets their values, only whether they're set. Left empty, they're kept.
  const [values, setValues] = useState<Record<string, string | null>>(bot.settings)
  const [saved, setSaved] = useState(false)
  const secretsSet = bot.secretsSet ?? []

  const save = async () => {
    await bridge.update(bot.id, { name, settings: values })
    setValues((v) => Object.fromEntries(Object.entries(v).filter(([key]) => !info?.settings.some((s) => s.env === key && s.kind === 'secret'))))
    setSaved(true)
  }

  return (
    <div className="pc-bot-settings">
      <label className="checkbox">
        {/* For a bot from a folder, the app asks in its own dialog before turning this on. */}
        <input type="checkbox" checked={bot.autostart} onChange={(e) => void bridge.update(bot.id, { autostart: e.target.checked })} />
        <span>
          {t('pcBots.autostart')}
          <br /><small className="muted">{t('pcBots.autostartHint')}</small>
        </span>
      </label>
      <form onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label className="field">
          <span>{t('pcBots.name')}</span>
          <input value={name} maxLength={32} onChange={(e) => { setName(e.target.value); setSaved(false) }} />
          <small className="muted">{t('pcBots.nameHint')}</small>
        </label>
        {info?.settings.map((s) => (
          <label className="field" key={s.env}>
            <span>{t(`pcBots.setting.${s.env}`, { defaultValue: s.env })}</span>
            <input type={s.kind === 'secret' ? 'password' : 'text'} inputMode={s.kind === 'number' ? 'numeric' : undefined} autoComplete="off" spellCheck={false}
              value={values[s.env] ?? ''} placeholder={s.kind === 'secret' && secretsSet.includes(s.env) && values[s.env] !== null ? '••••••••' : s.default} maxLength={300}
              onChange={(e) => { setValues({ ...values, [s.env]: e.target.value }); setSaved(false) }} />
            {s.kind === 'secret' && (
              <small className="muted">
                {secretsSet.includes(s.env) && values[s.env] !== null ? `${t('pcBots.secretSaved')} ` : ''}{t('pcBots.secretHint')}
                {secretsSet.includes(s.env) && values[s.env] !== null && (
                  <> <button type="button" className="button small" onClick={() => { setValues({ ...values, [s.env]: null }); setSaved(false) }}>{t('pcBots.secretClear')}</button></>
                )}
              </small>
            )}
          </label>
        ))}
        <p className="muted">{t('pcBots.settingsHint')}</p>
        <div className="copy-row">
          <button className="button primary">{t('common.save')}</button>
          {bot.kind === 'gallery' && !bot.needsInvite && <button type="button" className="button" onClick={onNewInvite}>{t('pcBots.invite.again')}</button>}
          {saved && <span className="muted" role="status">{t('pcBots.settingsSaved')}</span>}
        </div>
      </form>
    </div>
  )
}

/** The bot's last lines, refreshed every two seconds while open. Plain text, rendered by React. */
function BotLog({ bot }: { bot: PcBot }) {
  const { t } = useTranslation()
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    const load = () => void desktop!.bots!.log(bot.id).then((l) => alive && setLines(l), () => undefined)
    load()
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [bot.id])
  return (
    <pre className="pc-bot-log" aria-label={t('pcBots.logLabel', { name: bot.name })} tabIndex={0}>
      {lines.length ? lines.join('\n') : t('pcBots.logEmpty')}
    </pre>
  )
}
