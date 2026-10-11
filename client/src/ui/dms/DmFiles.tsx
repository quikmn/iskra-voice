// End-to-end encrypted attachments in DMs: the composer (attach, paste, drop, voice) and how attachments show.
import { useEffect, useRef, useState } from 'react'
import type { DmFile } from '../../core/dmFiles'
import { sendDm, sharedServers } from '../../state/dms'
import { sendGroupMessage } from '../../state/groups'
import { MAX_DM_FILE_BYTES, openDmFile, uploadDmFile, type OpenedFile } from '../../state/dmFiles'
import { draftKey, setDraft, useDraft } from '../../state/drafts'
import { ImageGrid, Lightbox, SpoilerCover, SpoilerToggle, isSpoilerName, longTextFile, shownName } from '../chat/media'
import { formatSize } from '../chat/helpers'
import { Close, FileIcon, Lock, Paperclip, Send } from '../icons'
import { VoicePlayer, VoiceRecordButton } from '../chat/voice/VoiceMessages'
import { voiceRecordingSupported, type Recording } from '../chat/voice/recorder'
import './dm-files.css'

/** Decrypted automatically when small enough; bigger files wait for a click. */
const AUTO_OPEN_BYTES = 15 * 1024 * 1024
export const DM_ATTACH_EVENT = 'iskra:attach-dm'

interface PendingUpload {
  localId: string
  file: File
  preview: string | null
  progress: number
  result: DmFile | null
  /** Shown covered until clicked; the name gets SPOILER_ when sent (names travel inside the encrypted message). */
  spoiler?: boolean
  error: string | null
  abort: AbortController
}

/** Composer for a DM with `peer`, or for a group DM when `group` is given (files are then readable by its members). */
export function DmComposer({ peer, placeholder, group }: {
  peer: string; placeholder: string; group?: { key: string; serverKey: string; id: string }
}) {
  const draft = group ? draftKey.dm(`g:${group.key}`) : draftKey.dm(peer)
  const text = useDraft(draft)
  const setText = (value: string) => setDraft(draft, value)
  const [uploads, setUploads] = useState<PendingUpload[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const route = group ? group.serverKey : sharedServers(peer)[0]
  const target = group ? { groupId: group.id } : peer
  const send = (body: string, files: DmFile[]) =>
    group ? sendGroupMessage(group.key, body, files.length ? { files } : {}) : sendDm(peer, body, files.length ? { files } : {})
  const uploading = uploads.some((u) => !u.result && !u.error)
  const ready = uploads.filter((u) => u.result).map((u) => u.result!)
  const canSend = !!route && !uploading && (text.trim().length > 0 || ready.length > 0)

  function addFiles(files: File[]) {
    if (!route) return
    for (const file of files.slice(0, 10 - uploads.length)) {
      const item: PendingUpload = {
        localId: `${Date.now()}-${Math.random()}`, file, progress: 0, result: null, abort: new AbortController(),
        error: file.size > MAX_DM_FILE_BYTES ? `Up to ${MAX_DM_FILE_BYTES / 1024 / 1024} MB in direct messages.` : null,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      }
      setUploads((list) => [...list, item])
      if (item.error) continue
      const update = (patch: Partial<PendingUpload>) => setUploads((list) => list.map((u) => (u.localId === item.localId ? { ...u, ...patch } : u)))
      uploadDmFile(route, target, file, (progress) => update({ progress }), item.abort.signal)
        .then((result) => update({ result, progress: 1 }))
        .catch((e: Error) => e.name !== 'AbortError' && update({ error: e.message }))
    }
  }

  function removeUpload(item: PendingUpload) {
    item.abort.abort()
    if (item.preview) URL.revokeObjectURL(item.preview)
    setUploads((list) => list.filter((u) => u.localId !== item.localId))
  }

  useEffect(() => {
    const onAttach = (e: Event) => addFiles((e as CustomEvent<File[]>).detail)
    window.addEventListener(DM_ATTACH_EVENT, onAttach)
    return () => window.removeEventListener(DM_ATTACH_EVENT, onAttach)
  })

  function submit() {
    if (!canSend) return
    const files = uploads.filter((u) => u.result && u.result.server === ready[0]?.server)
      .map((u) => (u.spoiler && !isSpoilerName(u.result!.name) ? { ...u.result!, name: `SPOILER_${u.result!.name}` } : u.result!))
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview)
    setUploads([])
    setText('')
    void send(text.trim(), files)
  }

  async function sendVoice(recording: Recording) {
    if (!route) throw new Error("You don't share an online server with this person right now.")
    const file = await uploadDmFile(route, target, recording.file, () => {}, undefined, { duration: recording.duration, waveform: recording.waveform })
    await send('', [file])
  }

  return (
    <div className="composer-wrap">
      {uploads.length > 0 && (
        <div className="pending-uploads">
          {uploads.map((u) => (
            <div key={u.localId} className={`pending-upload ${u.error ? 'failed' : ''}`} title={u.error ?? u.file.name}>
              {u.preview ? <img src={u.preview} alt="" /> : <span className="file-icon" aria-hidden><FileIcon size={20} /></span>}
              <span className="file-name">{u.file.name}</span>
              <SpoilerToggle on={!!u.spoiler} onToggle={() => setUploads((list) => list.map((x) => (x.localId === u.localId ? { ...x, spoiler: !x.spoiler } : x)))} />
              <span className="muted">{u.error ? 'Failed' : u.result ? formatSize(u.file.size) : `${Math.round(u.progress * 100)}%`}</span>
              {!u.result && !u.error && <span className="upload-progress" style={{ width: `${u.progress * 100}%` }} />}
              <button className="icon-button small" onClick={() => removeUpload(u)} aria-label={`Remove ${u.file.name}`}><Close size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <button className="icon-button attach-button" onClick={() => fileInput.current?.click()} aria-label="Attach files" title="Attach files (end-to-end encrypted)">
          <Paperclip />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <textarea
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              addFiles(files)
              return
            }
            const pasted = e.clipboardData.getData('text')
            if (text.length + pasted.length > 4000) {
              e.preventDefault()
              addFiles([longTextFile(pasted)])
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {!text.trim() && uploads.length === 0 && voiceRecordingSupported() && <VoiceRecordButton onSend={sendVoice} disabled={!route} />}
        <button className="send-button" onClick={submit} disabled={!canSend} aria-label="Send">
          <Send />
        </button>
      </div>
    </div>
  )
}

// ── Showing attachments ─────────────────────────────────────────────────────

export function DmAttachments({ files }: { files: DmFile[] | undefined }) {
  if (!files?.length) return null
  return (
    <div className="attachments">
      {files.map((file) => <DmAttachment key={`${file.server}:${file.id}`} file={file} />)}
    </div>
  )
}

function useOpened(file: DmFile, auto: boolean) {
  const [state, setState] = useState<{ opened: OpenedFile | null; error: string | null; busy: boolean }>({ opened: null, error: null, busy: false })
  const open = () => {
    setState((s) => ({ ...s, busy: true, error: null }))
    openDmFile(file).then(
      (opened) => setState({ opened, error: null, busy: false }),
      (e: Error) => setState({ opened: null, error: e.message || "Couldn't open this file.", busy: false }),
    )
  }
  useEffect(() => {
    if (auto) open()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.server, file.id, auto])
  return { ...state, open }
}

function DmAttachment({ file }: { file: DmFile }) {
  const media = file.voice || /^(image|video|audio)\//.test(file.type)
  const { opened, error, busy, open } = useOpened(file, !!media && file.size <= AUTO_OPEN_BYTES)
  const [zoom, setZoom] = useState(false)

  if (file.voice) {
    if (error) return <div className="message-notice"><Lock size={13} /> {error} <button className="link" onClick={open}>Retry</button></div>
    return <VoicePlayer src={opened?.url ?? null} voice={file.voice} />
  }
  if (opened?.inline && opened.type.startsWith('image/')) {
    const items = [{ url: opened.url, name: file.name, size: file.size }]
    return (
      <>
        <ImageGrid items={items} onOpen={() => setZoom(true)} />
        {zoom && <Lightbox items={items} start={0} onClose={() => setZoom(false)} />}
      </>
    )
  }
  if (opened?.inline && opened.type.startsWith('video/')) {
    return <SpoilerCover active={isSpoilerName(file.name)}><video className="attachment-video" src={opened.url} controls preload="metadata" /></SpoilerCover>
  }
  if (opened?.inline && opened.type.startsWith('audio/')) {
    return (
      <div className="attachment-file">
        <span className="file-name">{shownName(file.name)}</span>
        <audio src={opened.url} controls preload="metadata" />
      </div>
    )
  }

  // Anything else (or not opened yet): a file row that decrypts on demand and saves under its name.
  return (
    <div className="attachment-file dm-file">
      <span className="file-icon" aria-hidden><FileIcon size={22} /></span>
      <span className="file-name">{shownName(file.name)}</span>
      <span className="muted">{formatSize(file.size)}</span>
      {opened ? (
        <a className="button small" href={opened.url} download={shownName(file.name)}>Save</a>
      ) : (
        <button className="button small" disabled={busy} onClick={open}>{busy ? 'Decrypting…' : 'Download'}</button>
      )}
      {error && <span className="error-text dm-file-error">{error}</span>}
    </div>
  )
}
