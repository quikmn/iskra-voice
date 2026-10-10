// The events dialog: upcoming and live events as cards (interested, add to calendar, join), and the create/edit form.
import { useEffect, useRef, useState } from 'react'
import type { ServerEvent } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { cancelEvent, canCreateEvent, canManageEvent, setInterested, useEvents } from '../../state/events'
import { creatorTime, eventIcs, formatRange, icsFileName, localZone, openEvents, startsIn } from '../../state/eventTime'
import { joinVoice } from '../../state/voice'
import { Avatar, Modal } from '../bits'
import { Pencil, Plus, Volume } from '../icons'
import { CalendarIcon, CalendarPlus, MapPin, StarIcon } from '../forums/icons'
import { EventForm } from './EventForm'
import { useNow } from './EventsLayer'

export function EventsDialog({ server, focus, onClose }: { server: ServerState; focus?: number; onClose: () => void }) {
  const events = useEvents((s) => s.events[server.key])
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'form'; event?: ServerEvent }>({ kind: 'list' })
  const now = useNow()
  const list = openEvents(Object.values(events ?? {}))
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode.kind !== 'list' || focus === undefined) return
    listRef.current?.querySelector(`#event-${focus}`)?.scrollIntoView({ block: 'center' })
  }, [focus, mode.kind])

  if (mode.kind === 'form') {
    const editing = mode.event ? events?.[mode.event.id] ?? mode.event : undefined
    return (
      <EventForm
        server={server}
        event={editing}
        onBack={() => setMode({ kind: 'list' })}
        onClose={onClose}
      />
    )
  }

  return (
    <Modal
      title="Events"
      heading={<>Events <span className="muted">on {server.name}</span></>}
      onClose={onClose}
      wide
      className="events-modal"
      footer={canCreateEvent(server) ? (
        <button className="button primary" onClick={() => setMode({ kind: 'form' })}><Plus size={16} /> Schedule an event</button>
      ) : undefined}
    >
      <div ref={listRef} className="event-list">
        {list.length === 0 ? (
          <div className="event-empty">
            <span className="empty-icon"><CalendarIcon size={30} /></span>
            <h3>Nothing planned yet</h3>
            <p className="muted">{canCreateEvent(server) ? 'Plan a game night, a movie or a meetup. People can say they are interested and get a reminder before it starts.' : 'Events members plan show up here.'}</p>
          </div>
        ) : (
          list.map((event) => (
            <EventCard key={event.id} server={server} event={event} now={now} focused={event.id === focus}
              onEdit={() => setMode({ kind: 'form', event })} onJoined={onClose} />
          ))
        )}
      </div>
    </Modal>
  )
}

/** Where it is, in words ("lounge" for a voice channel here, or the text). */
export function placeOf(server: ServerState, event: ServerEvent): { label: string; voiceId: number | null } {
  if (event.location.kind === 'place') return { label: event.location.text, voiceId: null }
  const channel = server.channels.find((c) => c.id === (event.location as { channelId: number | null }).channelId)
  return channel ? { label: channel.name, voiceId: channel.id } : { label: 'A voice channel', voiceId: null }
}

function downloadIcs(server: ServerState, event: ServerEvent) {
  const place = placeOf(server, event)
  const ics = eventIcs(event, { serverKey: server.key, place: place.voiceId !== null ? `${place.label} (voice) on ${server.name}` : place.label })
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = icsFileName(event.title)
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function EventCard({ server, event, now, focused, onEdit, onJoined }: {
  server: ServerState; event: ServerEvent; now: number; focused: boolean; onEdit: () => void; onJoined: () => void
}) {
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const me = server.me?.accountKey
  const interested = !!me && event.interested.includes(me)
  const live = event.status === 'live' || event.startAt <= now
  const place = placeOf(server, event)
  const zone = localZone()
  const theirs = creatorTime(event, zone)
  const creator = server.members[event.createdBy]
  const start = new Date(event.startAt)
  const soon = startsIn(event.startAt, now)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article id={`event-${event.id}`} className={`event-card ${live ? 'live' : ''} ${focused ? 'focused' : ''}`} aria-label={event.title}>
      {event.image && (
        <img className="event-cover" src={server.url + event.image.url} alt="" width={event.image.width ?? undefined} height={event.image.height ?? undefined} />
      )}
      <div className="event-top">
        <div className="event-date" aria-hidden>
          <span>{start.toLocaleDateString(undefined, { month: 'short' })}</span>
          <strong>{start.getDate()}</strong>
        </div>
        <div className="event-head">
          <div className="event-status">
            {live ? <span className="live-pill">Live now</span> : soon && <span className="muted">{soon}</span>}
          </div>
          <h3>{event.title}</h3>
          <p className="event-when">
            <time dateTime={start.toISOString()}>{formatRange(event.startAt, event.endAt)}</time>
            {theirs && <span className="muted"> ({theirs})</span>}
          </p>
          <p className="event-where">
            {place.voiceId !== null ? <Volume size={14} /> : <MapPin size={14} />}
            <span>{place.label}</span>
          </p>
        </div>
      </div>
      {event.description && <p className="event-description">{event.description}</p>}
      <div className="event-people">
        <div className="avatar-stack" aria-hidden>
          {event.interested.slice(0, 5).map((key) => (
            <Avatar key={key} name={server.members[key]?.name ?? '?'} accountKey={key} size={22} />
          ))}
        </div>
        <span className="muted">
          {event.interested.length} interested · planned by {creator?.name ?? 'a former member'}
        </span>
      </div>
      <div className="event-actions">
        <button
          className={`button small ${interested ? 'interested' : ''}`}
          aria-pressed={interested}
          disabled={busy}
          onClick={() => void run(() => setInterested(server.key, event.id, !interested))}
        >
          <StarIcon size={14} filled={interested} /> {interested ? 'Interested' : "I'm interested"}
        </button>
        {live && place.voiceId !== null && server.voiceAvailable && (
          <button
            className="button primary small"
            onClick={() => {
              void joinVoice(server.key, place.voiceId!)
              onJoined()
            }}
          >
            <Volume size={14} /> Join voice
          </button>
        )}
        <button className="button ghost small" onClick={() => downloadIcs(server, event)}>
          <CalendarPlus size={14} /> Add to calendar
        </button>
        {canManageEvent(server, event) && (
          confirmCancel ? (
            <span className="confirm-inline">
              Cancel this event?
              <button className="button danger small" disabled={busy} onClick={() => void run(() => cancelEvent(server.key, event.id))}>Cancel event</button>
              <button className="button small" onClick={() => setConfirmCancel(false)}>Keep</button>
            </span>
          ) : (
            <>
              <button className="button ghost small" onClick={onEdit}><Pencil size={14} /> Edit</button>
              <button className="button ghost small danger-text" onClick={() => setConfirmCancel(true)}>Cancel event</button>
            </>
          )
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </article>
  )
}
