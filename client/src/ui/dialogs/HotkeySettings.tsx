import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop } from '../../platform/desktop'
import {
  captureWebHotkey, globalHotkeys, HOTKEY_ACTIONS, setDesktopHotkey, setWebHotkey, useHotkeys, type HotkeyAction,
} from '../../state/hotkeys'
import { PushToTalkHint, usePushToTalkStatus } from './VoiceSettings'
import './hotkeys.css'

const NAMES = { mute: 'settings.hotkeys.mute', deafen: 'settings.hotkeys.deafen' } as const satisfies Record<HotkeyAction, string>

/** Mute and deafen keybinds: global on desktop (even in games), in-app shortcuts in the browser. */
export function HotkeySettingsSection() {
  const { t } = useTranslation()
  const global = globalHotkeys()
  const binds = useHotkeys((s) => (global ? s.desktop : s.web))
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null)
  const abort = useRef<AbortController | null>(null)
  const status = usePushToTalkStatus(global)

  // Leaving the section mid-capture stops listening.
  useEffect(() => () => {
    abort.current?.abort()
    void desktop?.cancelHotkeyCapture?.()
  }, [])

  // Desktop: the shell sees the keys; the page mustn't act on them too (Escape would close Settings).
  useEffect(() => {
    if (!global || !capturing) return
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', swallow, true)
    return () => window.removeEventListener('keydown', swallow, true)
  }, [global, capturing])

  async function capture(action: HotkeyAction) {
    abort.current?.abort()
    if (global) void desktop!.cancelHotkeyCapture?.()
    setCapturing(action)
    if (global) {
      const captured = await desktop!.captureHotkey!()
      if (captured) setDesktopHotkey(action, { code: captured.code, mods: captured.mods, label: captured.name })
    } else {
      const controller = new AbortController()
      abort.current = controller
      const captured = await captureWebHotkey(controller.signal)
      if (controller.signal.aborted) return
      if (captured) setWebHotkey(action, captured)
    }
    setCapturing((current) => (current === action ? null : current))
  }

  function cancel() {
    abort.current?.abort()
    void desktop?.cancelHotkeyCapture?.()
    setCapturing(null)
  }

  function clear(action: HotkeyAction) {
    if (global) setDesktopHotkey(action, null)
    else setWebHotkey(action, null)
  }

  return (
    <section className="settings-section">
      <h3>{t('settings.hotkeys.title')}</h3>
      <div className="hotkey-list">
        {HOTKEY_ACTIONS.map((action) => {
          const label = binds[action]?.label
          const waiting = capturing === action
          return (
            <div className="hotkey-row" key={action}>
              <span className="hotkey-name" id={`hotkey-${action}`}>{t(NAMES[action])}</span>
              <span className={`key-chip ${label || waiting ? '' : 'unset'}`} aria-labelledby={`hotkey-${action}`} aria-live="polite">
                {waiting ? t('settings.voice.pressKey') : (label ?? t('settings.hotkeys.notSet'))}
              </span>
              <div className="hotkey-actions">
                {waiting ? (
                  <button className="button small" onClick={cancel}>{t('common.cancel')}</button>
                ) : (
                  <button className="button small" onClick={() => void capture(action)}
                    aria-label={t(label ? 'settings.hotkeys.changeFor' : 'settings.hotkeys.setFor', { action: t(NAMES[action]).toLowerCase() })}>
                    {label ? t('settings.hotkeys.change') : t('settings.voice.setKey')}
                  </button>
                )}
                {label && !waiting && (
                  <button className="button ghost small" onClick={() => clear(action)}
                    aria-label={t('settings.hotkeys.clearFor', { action: t(NAMES[action]).toLowerCase() })}>{t('common.clear')}</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {capturing && <p className="muted">{global ? t('settings.hotkeys.comboHintDesktop') : t('settings.hotkeys.comboHint')}</p>}
      {global ? (
        <>
          <PushToTalkHint status={status} />
          <p className="muted">{t('settings.hotkeys.plainKeys')}</p>
        </>
      ) : (
        <p className="muted">{t('settings.hotkeys.browser')}</p>
      )}
    </section>
  )
}
