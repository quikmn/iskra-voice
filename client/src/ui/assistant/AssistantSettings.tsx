// My settings → Assistant: bring your own AI. Turn it on, pick a provider (or a model on this computer), keep the key
// sealed on this device, test the connection, choose what the tools may do, and (desktop app) the local MCP bridge.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { saveConfig, testConnection, useAssistant } from '../../state/assistant/assistant'
import { ProviderError } from '../../state/assistant/providers'
import { checkBaseUrl, isLocalUrl, providerHost } from '../../state/assistant/url'
import { PRESETS, type ProviderPreset } from '../../state/assistant/types'
import { desktop } from '../../platform/desktop'
import './assistant.css'

const PRESET_IDS = Object.keys(PRESETS) as ProviderPreset[]

export function AssistantSettingsSection() {
  const loaded = useAssistant((s) => s.loaded)
  return loaded ? <Settings /> : null
}

function Settings() {
  const { t } = useTranslation()
  const config = useAssistant((s) => s.config)
  const mcpCommand = useAssistant((s) => s.mcpCommand)
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [model, setModel] = useState(config.model)
  const [key, setKey] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [test, setTest] = useState<{ state: 'idle' | 'testing' } | { state: 'ok'; count: number } | { state: 'error'; text: string }>({ state: 'idle' })
  const [copied, setCopied] = useState<string | null>(null)
  const [keyDropped, setKeyDropped] = useState(false)
  const [baseRefused, setBaseRefused] = useState(false)
  const save = (patch: Parameters<typeof saveConfig>[0]) => void saveConfig(patch).then((result) => {
    if (result.keyDropped) setKeyDropped(true)
    setBaseRefused(result.baseRefused)
  })
  const url = checkBaseUrl(baseUrl)

  function pickPreset(preset: ProviderPreset) {
    const p = PRESETS[preset]
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setModels([])
    setTest({ state: 'idle' })
    save({ preset, kind: p.kind, baseUrl: p.baseUrl, model: p.model })
  }

  async function runTest() {
    setTest({ state: 'testing' })
    try {
      const found = await testConnection(useAssistant.getState().config)
      setModels(found)
      setTest({ state: 'ok', count: found.length })
    } catch (e) {
      const error = e instanceof ProviderError ? e : new ProviderError('network')
      const text = t(`assistant.errors.${error.code}`, { status: error.status ?? '' })
      setTest({ state: 'error', text: error.detail && error.code !== 'network' ? `${text} ${error.detail}` : text })
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text).then(() => setCopied(text))
  }

  const host = providerHost(config.baseUrl) ?? ''
  const claudeCode = mcpCommand ? `claude mcp add iskra -- ${mcpCommand.map((part) => `"${part}"`).join(' ')} --mcp` : null
  const claudeDesktop = mcpCommand ? JSON.stringify({ mcpServers: { iskra: { command: mcpCommand[0], args: [...mcpCommand.slice(1), '--mcp'] } } }, null, 2) : null

  return (
    <>
      <section className="settings-section assistant-settings" data-testid="assistant-settings">
        <h2>{t('settings.sections.assistant')}</h2>
        <p className="muted">{t('assistant.settingsSection.intro')}</p>
        <div className="internet-head">
          <strong>{t('assistant.settingsSection.enable')}</strong>
          <button className={`switch ${config.enabled ? 'on' : ''}`} role="switch" aria-checked={config.enabled}
            aria-label={t('assistant.settingsSection.enable')} onClick={() => save({ enabled: !config.enabled })}>
            <span />
          </button>
        </div>

        <label className="field">
          <span>{t('assistant.settingsSection.provider')}</span>
          <select value={config.preset} onChange={(e) => pickPreset(e.target.value as ProviderPreset)}>
            {PRESET_IDS.map((id) => <option key={id} value={id}>{t(`assistant.settingsSection.presets.${id}`)}</option>)}
          </select>
        </label>

        <div className="field">
          <label htmlFor="assistant-base-url"><span>{t('assistant.settingsSection.baseUrl')}</span></label>
          <input id="assistant-base-url" aria-describedby="assistant-base-url-hint" value={baseUrl} spellCheck={false} autoComplete="off" inputMode="url" placeholder="https://…"
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => url.ok && url.url !== config.baseUrl && save({ baseUrl: url.url })} />
          <small id="assistant-base-url-hint" className={url.ok || !baseUrl ? 'muted' : 'error-text'}>
            {url.ok || !baseUrl ? t('assistant.settingsSection.baseUrlHint') : t(`assistant.settingsSection.badUrl.${url.problem}`)}
          </small>
          {baseRefused && <small className="error-text" role="alert">{t('assistant.settingsSection.baseRefused')}</small>}
        </div>

        <div className="field">
          <span>{t('assistant.settingsSection.key')}</span>
          {config.key && !replacing ? (
            <div className="assistant-key-row">
              <span className="muted">{t('assistant.settingsSection.keySaved', { last: config.key.slice(-4) })}</span>
              <button className="button small" onClick={() => setReplacing(true)}>{t('assistant.settingsSection.replaceKey')}</button>
              <button className="button small danger" onClick={() => void saveConfig({ key: '' })}>{t('assistant.settingsSection.removeKey')}</button>
            </div>
          ) : (
            <form className="assistant-key-row" onSubmit={(e) => {
              e.preventDefault()
              if (!key.trim()) return
              void saveConfig({ key: key.trim() }).then(() => {
                setKeyDropped(false)
                setKey('')
                setReplacing(false)
              })
            }}>
              <input type="password" value={key} autoComplete="off" spellCheck={false} aria-label={t('assistant.settingsSection.key')}
                placeholder={config.key ? '' : t('assistant.settingsSection.keyNone')} onChange={(e) => setKey(e.target.value)} />
              <button className="button small primary" type="submit" disabled={!key.trim()}>{t('assistant.settingsSection.saveKey')}</button>
            </form>
          )}
          {keyDropped && !config.key && <small className="warning-text" role="note">{t('assistant.settingsSection.keyDropped')}</small>}
          <small className="muted">{t('assistant.settingsSection.keyHint')}{isLocalUrl(config.baseUrl) ? ` ${t('assistant.settingsSection.keyOptional')}` : ''}</small>
        </div>

        <div className="field">
          <label htmlFor="assistant-model"><span>{t('assistant.settingsSection.model')}</span></label>
          <input id="assistant-model" aria-describedby="assistant-model-hint" value={model} list="assistant-models" spellCheck={false} autoComplete="off"
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model.trim() !== config.model && void saveConfig({ model: model.trim() })} />
          <datalist id="assistant-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          <small id="assistant-model-hint" className="muted">{t('assistant.settingsSection.modelHint')}</small>
        </div>

        <div className="assistant-test-row">
          <button className="button" disabled={test.state === 'testing' || !checkBaseUrl(config.baseUrl).ok} onClick={() => void runTest()}>
            {test.state === 'testing' ? t('assistant.settingsSection.testing') : t('assistant.settingsSection.test')}
          </button>
          {test.state === 'ok' && <span role="status" className="success-text">{t('assistant.settingsSection.testOk', { count: test.count })}</span>}
          {test.state === 'error' && <span role="alert" className="error-text">{test.text}</span>}
        </div>
        {host && (
          <p className="assistant-privacy" data-testid="assistant-privacy-line">
            {t(isLocalUrl(config.baseUrl) ? 'assistant.privacyLocal' : 'assistant.privacy', { host })}
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2>{t('assistant.settingsSection.toolsTitle')}</h2>
        <p className="muted">{t('assistant.settingsSection.toolsIntro')}</p>
        <label className="checkbox">
          <input type="checkbox" checked={config.moderation} onChange={(e) => void saveConfig({ moderation: e.target.checked })} />
          {t('assistant.settingsSection.moderation')}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={config.admin} onChange={(e) => void saveConfig({ admin: e.target.checked })} />
          {t('assistant.settingsSection.admin')}
        </label>
        <p className="muted">{t('assistant.settingsSection.toolsNote')}</p>
      </section>

      {desktop?.assistant && (
        <section className="settings-section" data-testid="assistant-mcp">
          <h2>{t('assistant.settingsSection.mcpTitle')}</h2>
          <p className="muted">{t('assistant.settingsSection.mcpIntro')}</p>
          <label className="checkbox">
            <input type="checkbox" checked={config.mcp} disabled={!config.enabled} onChange={(e) => void saveConfig({ mcp: e.target.checked })} />
            {t('assistant.settingsSection.mcp')}
          </label>
          {claudeCode && claudeDesktop && (
            <>
              <p className="muted">{t('assistant.settingsSection.mcpCommand')}</p>
              <div className="assistant-command">
                <code>{claudeCode}</code>
                <button className="button small" onClick={() => copy(claudeCode)}>{copied === claudeCode ? t('assistant.settingsSection.copied') : t('assistant.settingsSection.copy')}</button>
              </div>
              <p className="muted">{t('assistant.settingsSection.mcpDesktop')}</p>
              <div className="assistant-command">
                <pre><code>{claudeDesktop}</code></pre>
                <button className="button small" onClick={() => copy(claudeDesktop)}>{copied === claudeDesktop ? t('assistant.settingsSection.copied') : t('assistant.settingsSection.copy')}</button>
              </div>
            </>
          )}
        </section>
      )}
    </>
  )
}
