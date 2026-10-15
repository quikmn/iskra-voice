import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop } from '../../platform/desktop'
import {
  captureWebHotkey, globalHotkeys, HOTKEY_ACTIONS, keysAreGlobal, setDesktopHotkey, setWebHotkey, useHotkeys, type HotkeyAction,
} from '../../state/hotkeys'
import { PushToTalkHint, usePushToTalkStatus } from './VoiceSettings'
import './hotkeys.css'

const NAMES = {
  mute: 'settings.hotkeys.mute', deafen: 'settings.hotkeys.deafen', clip: 'clips.hotkey',
  whisper1: 'whisper.keys.list1', whisper2: 'whisper.keys.list2', whisper3: 'whisper.keys.list3', priority: 'whisper.keys.priority',
} as const satisfies Record<HotkeyAction, string>

/** A "press a key" row per action: global on desktop (even in games), in-app shortcuts in the browser. */
export function HotkeyRows({ actions, labels }: { actions: readonly HotkeyAction[]; labels?: Partial<Record<HotkeyAction, string>> }) {
  const { t } = useTranslation()
  const global = keysAreGlobal(actions)
  const binds = useHotkeys((s) => (global ? s.desktop : s.web))
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null)
  const abort = useRef<AbortController | null>(null)

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
    <>
      <div className="hotkey-list">
        {actions.map((action) => {
          const label = binds[action]?.label
          const waiting = capturing === action
          const name = labels?.[action] ?? t(NAMES[action])
          return (
            <div className="hotkey-row" key={action}>
              <span className="hotkey-name" id={`hotkey-${action}`}>{name}</span>
              <span className={`key-chip ${label || waiting ? '' : 'unset'}`} aria-labelledby={`hotkey-${action}`} aria-live="polite">
                {waiting ? t('settings.voice.pressKey') : (label ?? t('settings.hotkeys.notSet'))}
              </span>
              <div className="hotkey-actions">
                {waiting ? (
                  <button className="button small" onClick={cancel}>{t('common.cancel')}</button>
                ) : (
                  <button className="button small" onClick={() => void capture(action)}
                    aria-label={t(label ? 'settings.hotkeys.changeFor' : 'settings.hotkeys.setFor', { action: name.toLowerCase() })}>
                    {label ? t('settings.hotkeys.change') : t('settings.voice.setKey')}
                  </button>
                )}
                {label && !waiting && (
                  <button className="button ghost small" onClick={() => clear(action)}
                    aria-label={t('settings.hotkeys.clearFor', { action: name.toLowerCase() })}>{t('common.clear')}</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {capturing && <p className="muted">{global ? t('settings.hotkeys.comboHintDesktop') : t('settings.hotkeys.comboHint')}</p>}
    </>
  )
}

/** Mute, deafen and clip keybinds: global on desktop (even in games), in-app shortcuts in the browser. */
export function HotkeySettingsSection() {
  const { t } = useTranslation()
  const global = globalHotkeys()
  const status = usePushToTalkStatus(global)
  return (
    <section className="settings-section">
      <h2>{t('settings.hotkeys.title')}</h2>
      <HotkeyRows actions={HOTKEY_ACTIONS} />
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
