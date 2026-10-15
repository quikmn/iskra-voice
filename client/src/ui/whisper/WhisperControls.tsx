import type { KeyboardEvent, PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../../state/store'
import { useVoice } from '../../state/voice'
import {
  clearWhisperError, holdKey, priorityTalking, useWhisper, type WhisperSlot,
} from '../../state/whisper'
import type { HoldAction } from '../../state/hotkeys'
import { Close } from '../icons'
import { listName } from './listName'
import './whisper.css'

/** Press-and-hold handlers for a hold button (pointer and keyboard), so phones and the web can whisper too. */
function holdProps(action: HoldAction) {
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    holdKey(action, true)
  }
  const up = () => holdKey(action, false)
  return {
    onPointerDown: down,
    onPointerUp: up,
    onPointerCancel: up,
    onLostPointerCapture: up,
    onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault()
        holdKey(action, true)
      }
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === ' ' || e.key === 'Enter') holdKey(action, false)
    },
    onBlur: up,
  }
}

/** In the call bar: hold buttons for your whisper lists and priority, what you're doing, and who whispers to you. */
export function WhisperControls() {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)
  const speaking = useVoice((s) => s.speaking)
  const server = useApp((s) => (session ? s.servers[session.serverKey] : undefined))
  const lists = useWhisper((s) => (session ? s.lists[session.serverKey] : undefined))
  const active = useWhisper((s) => s.active)
  const incoming = useWhisper((s) => s.incoming)
  const priority = useWhisper((s) => s.priority)
  const priorityOn = useWhisper((s) => s.priorityOn)
  const error = useWhisper((s) => s.error)
  if (!session || session.call || session.group || !server) return null

  const usable = (lists ?? []).filter((l) => l.target)
  const canWhisper = session.whisper && session.state === 'connected'
  const showPriorityButton = session.priority && session.canSpeak && !priority.always && session.state === 'connected'
  const participants = server.voice[session.channelId] ?? []
  const prioritySpeaker = priorityTalking(participants, speaking, server.me?.accountKey)
  const live = Object.values(incoming).filter((w) => w.serverKey === session.serverKey && w.live)
  const nameOf = (key: string) => server.members[key]?.name ?? t('whisper.someone')
  const activeList = active && lists?.[active.slot - 1]
  const activeName = activeList ? listName(activeList, server, t('whisper.listN', { n: active.slot })) : ''

  const status = active
    ? active.connecting && !active.reached ? t('whisper.connecting')
      : active.reached === null ? t('whisper.whispering', { name: activeName })
      : active.reached.length === 0 ? t('whisper.reachingNobody', { name: activeName })
      : t('whisper.reaching', { name: activeName, count: active.reached.length })
    : null

  if (!usable.length && !showPriorityButton && !live.length && !status && !prioritySpeaker && !priorityOn && !error) return null
  return (
    <div className="whisper-controls" data-testid="whisper-controls">
      {live.map((w) => {
        const channel = w.channelId ? server.channels.find((c) => c.id === w.channelId) : undefined
        return (
          <div key={w.id} className="whisper-incoming" role="status" data-testid="whisper-incoming">
            <span className="whisper-dot" aria-hidden="true" />
            {channel ? t('whisper.incomingChannel', { name: nameOf(w.from), channel: channel.name }) : t('whisper.incoming', { name: nameOf(w.from) })}
          </div>
        )
      })}
      {prioritySpeaker && (
        <div className="whisper-priority-talking" role="status">
          <span className="priority-badge">{t('whisper.priority.badge')}</span> {t('whisper.priority.talking', { name: nameOf(prioritySpeaker) })}
        </div>
      )}
      {status && <div className="whisper-status" role="status" data-testid="whisper-status">{status}</div>}
      {priorityOn && !prioritySpeaker && <div className="whisper-status priority" role="status">{t('whisper.priority.on')}</div>}
      {error && (
        <div className="whisper-error" role="alert">
          <span>{error}</span>
          <button className="icon-button small" onClick={clearWhisperError} aria-label={t('app.dismiss')}><Close size={12} /></button>
        </div>
      )}
      {(canWhisper && usable.length > 0) || showPriorityButton ? (
        <div className="whisper-buttons">
          {canWhisper && usable.map((list) => {
            const name = listName(list, server, t('whisper.listN', { n: list.slot }))
            const on = active?.slot === list.slot
            return (
              <button key={list.slot} className={`button small whisper-hold ${on ? 'on' : ''}`} aria-pressed={on}
                aria-label={t('whisper.hold', { name })} title={t('whisper.hold', { name })} data-testid={`whisper-hold-${list.slot}`}
                {...holdProps(`whisper${list.slot as WhisperSlot}`)}>
                {t('whisper.holdShort')}: {name}
              </button>
            )
          })}
          {showPriorityButton && (
            <button className={`button small whisper-hold priority ${priorityOn ? 'on' : ''}`} aria-pressed={priorityOn}
              aria-label={t('whisper.priority.hold')} title={t('whisper.priority.hold')} data-testid="priority-hold" {...holdProps('priority')}>
              {t('whisper.priority.holdShort')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
