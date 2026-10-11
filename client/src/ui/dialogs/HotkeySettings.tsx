import { useEffect, useRef, useState } from 'react'
import { desktop } from '../../platform/desktop'
import {
  captureWebHotkey, globalHotkeys, HOTKEY_ACTIONS, setDesktopHotkey, setWebHotkey, useHotkeys, type HotkeyAction,
} from '../../state/hotkeys'
import { PushToTalkHint, usePushToTalkStatus } from './VoiceSettings'
import './hotkeys.css'

const NAMES: Record<HotkeyAction, string> = { mute: 'Toggle mute', deafen: 'Toggle deafen' }

/** Mute and deafen keybinds: global on desktop (even in games), in-app shortcuts in the browser. */
export function HotkeySettingsSection() {
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
      <h3>Keybinds</h3>
      <div className="hotkey-list">
        {HOTKEY_ACTIONS.map((action) => {
          const label = binds[action]?.label
          const waiting = capturing === action
          return (
            <div className="hotkey-row" key={action}>
              <span className="hotkey-name" id={`hotkey-${action}`}>{NAMES[action]}</span>
              <span className={`key-chip ${label || waiting ? '' : 'unset'}`} aria-labelledby={`hotkey-${action}`} aria-live="polite">
                {waiting ? 'Press a key…' : (label ?? 'Not set')}
              </span>
              <div className="hotkey-actions">
                {waiting ? (
                  <button className="button small" onClick={cancel}>Cancel</button>
                ) : (
                  <button className="button small" onClick={() => void capture(action)} aria-label={`${label ? 'Change' : 'Set'} ${NAMES[action].toLowerCase()} key`}>
                    {label ? 'Change' : 'Set key'}
                  </button>
                )}
                {label && !waiting && (
                  <button className="button ghost small" onClick={() => clear(action)} aria-label={`Clear ${NAMES[action].toLowerCase()} key`}>Clear</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {capturing && <p className="muted">Hold Ctrl, Shift or Alt for a combo{global ? ', or press a mouse side button' : ''}. Esc cancels.</p>}
      {global ? (
        <>
          <PushToTalkHint status={status} />
          <p className="muted">Plain keys don't fire while you're typing in Iskra; combos with Ctrl or Alt always do.</p>
        </>
      ) : (
        <p className="muted">
          In the browser, these shortcuts work while Iskra is the focused tab (plain keys not while you type). For hotkeys that work while you're in a game, use the desktop app.
        </p>
      )}
    </section>
  )
}
