// Scheduled events: the sidebar button (with a badge), the events dialog wherever it's opened from, and reminder toasts.
import { useApp, type ServerState } from '../../state/store'
import { closeEvents, dismissReminder, showEvents, useEvents } from '../../state/events'
import { openEvents, startsIn } from '../../state/eventTime'
import { joinVoice } from '../../state/voice'
import { Close } from '../icons'
import { CalendarIcon } from '../forums/icons'
import { EventsDialog } from './EventsDialog'
import { useNow } from './useNow'
import './events.css'

export function EventsButton({ server, onNavigate }: { server: ServerState; onNavigate: () => void }) {
  const events = useEvents((s) => s.events[server.key])
  const now = useNow()
  const list = openEvents(Object.values(events ?? {}))
  const live = list.filter((e) => e.status === 'live' || (e.startAt <= now && e.status === 'scheduled'))
  const next = list.find((e) => e.status === 'scheduled' && e.startAt > now)
  const hint = live.length > 0 ? `${live[0].title} is live` : next ? `${next.title} ${startsIn(next.startAt, now)}` : 'Nothing planned yet'
  if (!server.me) return null
  return (
    <button
      className={`channel events-button ${live.length ? 'live' : ''}`}
      onClick={() => {
        showEvents(server.key)
        onNavigate()
      }}
      title={hint}
      aria-label={`Events: ${list.length === 0 ? 'none planned' : `${list.length} upcoming`}${live.length ? `, ${live.length} live now` : ''}`}
    >
      <span className="hash"><CalendarIcon size={16} /></span>
      <span className="channel-name">Events</span>
      {live.length > 0 && <span className="live-pill">Live</span>}
      {list.length > 0 && <span className="badge event-badge">{list.length}</span>}
    </button>
  )
}

/** Mounted once in the shell. */
export function EventsLayer() {
  const open = useEvents((s) => s.open)
  const server = useApp((s) => (open ? s.servers[open.serverKey] : undefined))
  return (
    <>
      {open && server && <EventsDialog server={server} focus={open.eventId} onClose={closeEvents} />}
      <EventToasts />
    </>
  )
}

function EventToasts() {
  const reminders = useEvents((s) => s.reminders)
  const servers = useApp((s) => s.servers)
  if (reminders.length === 0) return null
  return (
    <div className="event-toasts" role="status" aria-live="polite">
      {reminders.map((r) => {
        const server = servers[r.serverKey]
        const voice = r.event.location.kind === 'voice' && r.event.location.channelId !== null
          ? server?.channels.find((c) => c.id === (r.event.location as { channelId: number }).channelId)
          : undefined
        return (
          <div key={r.id} className="event-toast">
            <span className="event-toast-icon"><CalendarIcon size={18} /></span>
            <div className="event-toast-text">
              <strong>{r.kind === 'live' ? `${r.event.title} is starting now` : `Starting soon: ${r.event.title}`}</strong>
              <span>{server?.name}{voice ? ` · ${voice.name}` : r.event.location.kind === 'place' ? ` · ${r.event.location.text}` : ''}</span>
            </div>
            {voice && r.kind === 'live' ? (
              <button className="button primary small" onClick={() => { void joinVoice(r.serverKey, voice.id); dismissReminder(r.id) }}>Join</button>
            ) : (
              <button className="button small" onClick={() => { showEvents(r.serverKey, r.event.id); dismissReminder(r.id) }}>View</button>
            )}
            <button className="icon-button small" aria-label="Dismiss" onClick={() => dismissReminder(r.id)}><Close size={14} /></button>
          </div>
        )
      })}
    </div>
  )
}
