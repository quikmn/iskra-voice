// A whiteboard in a voice call: "Whiteboard" in the call controls opens one (or shows the one that's open), and it
// takes the call's big spot. It stays with the channel until someone clears it.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { openVoiceBoard, voiceBoardFor, useWhiteboard } from '../../state/whiteboard'
import { errorMessage } from '../../i18n/errors'
import { create } from 'zustand'
import { Close } from '../icons'
import { BoardIcon } from './icons'
import { Whiteboard } from './Whiteboard'
import { useBoardAbilities, Viewers } from './WhiteboardView'
import { boardKey } from '../../state/whiteboard'

/** Which calls show their board (per channel, on this device). */
export const useBoardShown = create<Record<string, boolean>>(() => ({}))

export function WhiteboardButton({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const board = useWhiteboard(voiceBoardFor(server.key, channel.id))
  const key = boardKey(server.key, channel.id)
  const shown = useBoardShown((s) => !!s[key])
  const { canDraw } = useBoardAbilities(server, channel)
  const [error, setError] = useState<string | null>(null)
  if (channel.kind !== 'voice' || (!board && !canDraw)) return null

  async function toggle() {
    setError(null)
    if (shown) return useBoardShown.setState({ [key]: false })
    try {
      if (!board) await openVoiceBoard(server.key, channel.id)
      useBoardShown.setState({ [key]: true })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const label = shown ? t('whiteboard.hide') : board ? t('whiteboard.show') : t('whiteboard.open')
  return (
    <>
      <button className={`call-button ${shown ? 'on' : ''} ${board && !shown ? 'wb-waiting' : ''}`} onClick={() => void toggle()} aria-pressed={shown}
        aria-label={label} title={error ?? label} data-testid="whiteboard-button">
        <BoardIcon />
      </button>
      {error && <span className="sr-only" role="alert">{error}</span>}
    </>
  )
}

/** The board in the call's big spot, while shown. */
export function VoiceBoardPanel({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const board = useWhiteboard(voiceBoardFor(server.key, channel.id))
  const key = boardKey(server.key, channel.id)
  const shown = useBoardShown((s) => !!s[key])
  const viewers = useWhiteboard((s) => s.boards[key]?.viewers)
  const { canDraw, canClear } = useBoardAbilities(server, channel, board?.openedBy)
  if (!board || !shown) return null
  const opener = board.openedBy ? server.members[board.openedBy]?.name : null
  return (
    <section className="wb-call" aria-label={t('whiteboard.board')}>
      <header className="wb-call-head">
        <BoardIcon size={16} />
        <strong>{t('whiteboard.board')}</strong>
        {opener && <span className="muted small-text">{t('whiteboard.openedBy', { name: opener })}</span>}
        <span className="wb-spacer" />
        <Viewers server={server} viewers={viewers ?? []} />
        <button className="icon-button" onClick={() => useBoardShown.setState({ [key]: false })} aria-label={t('whiteboard.hide')} title={t('whiteboard.hide')}>
          <Close size={16} />
        </button>
      </header>
      <Whiteboard key={board.id} server={server} channel={channel} canDraw={canDraw} canClear={canClear} compact />
    </section>
  )
}
