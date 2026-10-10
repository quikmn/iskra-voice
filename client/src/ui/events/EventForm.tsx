// Creating or editing an event. Times are typed as wall-clock times in a chosen time zone (yours by default)
// and sent as UTC, with the zone, so everyone sees the right moment in their own time.
import { useMemo, useRef, useState } from 'react'
import type { FileInfo, ServerEvent } from '../../core/protocol'
import { uploadFile, type ServerState } from '../../state/store'
import { createEvent, updateEvent } from '../../state/events'
import { localZone, utcToZoned, zonedToUtc, zoneList } from '../../state/eventTime'
import { Modal } from '../bits'
import { Close, Volume } from '../icons'
import { ImageIcon, MapPin } from '../forums/icons'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** The next full hour, an hour from now: a sensible default start. */
function defaultStart(): number {
  const d = new Date(Date.now() + 3_600_000)
  d.setMinutes(0, 0, 0)
  return d.getTime() + 3_600_000
}

export function EventForm({ server, event, onBack, onClose }: { server: ServerState; event?: ServerEvent; onBack: () => void; onClose: () => void }) {
  const initialZone = event?.timeZone ?? localZone()
  const initialStart = event?.startAt ?? defaultStart()
  const initialEnd = event?.endAt ?? initialStart + 2 * 3_600_000
  const voiceChannels = server.channels.filter((c) => c.kind === 'voice')
  const live = event?.status === 'live'

  const [title, setTitle] = useState(event?.title ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [zone, setZone] = useState(initialZone)
  const [start, setStart] = useState(() => utcToZoned(initialStart, initialZone))
  const [end, setEnd] = useState(() => utcToZoned(initialEnd, initialZone))
  const [where, setWhere] = useState<'voice' | 'place'>(event ? event.location.kind : voiceChannels.length > 0 ? 'voice' : 'place')
  const [channelId, setChannelId] = useState<number | null>(
    event?.location.kind === 'voice' ? event.location.channelId : voiceChannels[0]?.id ?? null,
  )
  const [place, setPlace] = useState(event?.location.kind === 'place' ? event.location.text : '')
  const [image, setImage] = useState<FileInfo | null>(event?.image ?? null)
  const [uploading, setUploading] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const zones = useMemo(() => zoneList(zone), [zone])

  const startAt = zonedToUtc(start.date, start.time, zone)
  const endAt = zonedToUtc(end.date, end.time, zone)
  const problem = !title.trim() ? 'Give it a title.'
    : startAt === null || endAt === null ? 'Pick a date and time.'
      : !live && startAt < Date.now() - 60_000 ? 'Pick a time in the future.'
        : endAt <= startAt ? 'The end has to be after the start.'
          : endAt - startAt > 7 * 24 * 3_600_000 ? 'Events can last up to 7 days.'
            : where === 'voice' && channelId === null ? 'Pick a voice channel.'
              : where === 'place' && !place.trim() ? 'Say where it is.'
                : null

  async function pickImage(file: File | undefined) {
    if (!file) return
    if (!IMAGE_TYPES.includes(file.type)) return setError('Cover images must be PNG, JPEG, WebP or GIF.')
    if (file.size > MAX_IMAGE_BYTES) return setError('Cover images can be up to 5 MB.')
    setError(null)
    setUploading(0)
    try {
      setImage(await uploadFile(server.key, file, (p) => setUploading(p)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(null)
    }
  }

  // Moving the start keeps the length the same.
  function changeStart(next: { date: string; time: string }) {
    const before = zonedToUtc(start.date, start.time, zone)
    const after = zonedToUtc(next.date, next.time, zone)
    const length = before !== null && endAt !== null ? endAt - before : null
    setStart(next)
    if (after !== null && length !== null && length > 0) setEnd(utcToZoned(after + length, zone))
  }

  async function save() {
    if (problem || busy || startAt === null || endAt === null) return
    setBusy(true)
    setError(null)
    const fields = {
      title: title.trim(),
      description: description.trim(),
      startAt,
      endAt,
      timeZone: zone,
      location: where === 'voice' ? { channelId: channelId! } : { text: place.trim() },
      image: image?.id ?? '',
    }
    try {
      if (event) {
        await updateEvent(server.key, event.id, live ? { ...fields, startAt: event.startAt } : fields)
      } else {
        await createEvent(server.key, { ...fields, image: image?.id })
      }
      onBack()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={event ? 'Edit event' : 'Schedule an event'}
      onBack={onBack}
      onClose={onClose}
      wide
      className="events-modal"
      footer={
        <>
          <button className="button" onClick={onBack}>Back</button>
          <button className="button primary" disabled={!!problem || busy || uploading !== null} onClick={() => void save()}>
            {event ? 'Save' : 'Schedule'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Title</span>
        <input value={title} maxLength={100} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Game night" />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea value={description} maxLength={1000} rows={3} onChange={(e) => setDescription(e.target.value)} placeholder="What's the plan? (optional)" />
      </label>

      <div className="event-times">
        <label className="field">
          <span>Starts</span>
          <div className="date-time">
            <input type="date" aria-label="Start date" value={start.date} disabled={live} onChange={(e) => changeStart({ ...start, date: e.target.value })} />
            <input type="time" aria-label="Start time" value={start.time} disabled={live} onChange={(e) => changeStart({ ...start, time: e.target.value })} />
          </div>
        </label>
        <label className="field">
          <span>Ends</span>
          <div className="date-time">
            <input type="date" aria-label="End date" value={end.date} onChange={(e) => setEnd({ ...end, date: e.target.value })} />
            <input type="time" aria-label="End time" value={end.time} onChange={(e) => setEnd({ ...end, time: e.target.value })} />
          </div>
        </label>
      </div>
      <label className="field">
        <span>Time zone</span>
        <select value={zone} disabled={live} onChange={(e) => setZone(e.target.value)}>
          {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
        </select>
      </label>
      {zone !== localZone() && startAt !== null && (
        <p className="muted event-local-hint">That's {new Date(startAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} your time.</p>
      )}

      <div className="field">
        <span>Where</span>
        <div className="segmented" role="radiogroup" aria-label="Where">
          <button role="radio" aria-checked={where === 'voice'} className={where === 'voice' ? 'on' : ''} disabled={voiceChannels.length === 0} onClick={() => setWhere('voice')}>
            <Volume size={16} /> Voice channel
          </button>
          <button role="radio" aria-checked={where === 'place'} className={where === 'place' ? 'on' : ''} onClick={() => setWhere('place')}>
            <MapPin size={16} /> Somewhere else
          </button>
        </div>
        {where === 'voice' ? (
          <select aria-label="Voice channel" value={channelId ?? ''} onChange={(e) => setChannelId(Number(e.target.value))}>
            {channelId !== null && !voiceChannels.some((c) => c.id === channelId) && <option value={channelId}>A voice channel</option>}
            {voiceChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : (
          <input aria-label="Place" value={place} maxLength={100} onChange={(e) => setPlace(e.target.value)} placeholder="A link, an address, or a game server" />
        )}
      </div>

      <div className="field">
        <span>Cover image</span>
        {image ? (
          <div className="event-cover-preview">
            <img src={server.url + image.url} alt="Cover" />
            <button className="icon-button" aria-label="Remove cover image" onClick={() => setImage(null)}><Close size={16} /></button>
          </div>
        ) : (
          <button className="button small cover-pick" onClick={() => fileInput.current?.click()} disabled={uploading !== null}>
            <ImageIcon size={14} /> {uploading !== null ? `Uploading ${Math.round(uploading * 100)}%` : 'Add a cover image'}
          </button>
        )}
        <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = '' }} />
      </div>

      {(error || (problem && title.trim())) && <p className="error-text">{error ?? problem}</p>}
    </Modal>
  )
}
