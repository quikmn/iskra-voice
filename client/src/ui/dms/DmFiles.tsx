// End-to-end encrypted attachments in DMs: the composer (attach, paste, drop, voice) and how attachments show.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t as translate } from '../../i18n'
import { formatNumber } from '../../i18n/format'
import type { DmFile } from '../../core/dmFiles'
import { dmErrorText, sendDm, sharedServers } from '../../state/dms'
import { sendGroupMessage } from '../../state/groups'
import { canStreamToDisk, IN_MEMORY_NOTE_BYTES, openDmFile, saveDmFile, uploadDmFile, type OpenedFile } from '../../state/dmFiles'
import { draftKey, setDraft, useDraft } from '../../state/drafts'
import { ImageGrid, Lightbox, SpoilerCover, SpoilerToggle, isSpoilerName, longTextFile, shownName } from '../chat/media'
import { formatSize } from '../chat/helpers'
import { Close, FileIcon, Lock, Paperclip, Send, Smile } from '../icons'
import { EmojiPicker } from '../expressions/EmojiPicker'
import { insertAt } from '../expressions/emoji'
import { VoicePlayer, VoiceRecordButton } from '../chat/voice/VoiceMessages'
import { voiceRecordingSupported, type Recording } from '../chat/voice/recorder'
import { useSendLater } from '../productivity/SendLater'
import { useQueuedSend } from '../chat/QueuedSend'
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
  const box = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const { t } = useTranslation()
  const route = group ? group.serverKey : sharedServers(peer)[0]
  const target = group ? { groupId: group.id } : peer
  const send = (body: string, files: DmFile[]) =>
    group ? sendGroupMessage(group.key, body, files.length ? { files } : {}) : sendDm(peer, body, files.length ? { files } : {})
  const uploading = uploads.some((u) => !u.result && !u.error)
  const ready = uploads.filter((u) => u.result).map((u) => u.result!)
  const canSend = !!route && !uploading && (text.trim().length > 0 || ready.length > 0)
  const canQueue = !!route && uploading
  const queue = useQueuedSend(uploads.map((u) => ({ done: !!u.result, failed: !!u.error })), () => submit())
  const later = useSendLater({
    target: group ? { kind: 'group', key: group.key } : { kind: 'dm', peer },
    prepare: () => text.trim() || null,
    blocked: uploads.length > 0 ? t('productivity.sendLater.noFiles') : null,
    disabled: !route,
    onScheduled: () => setText(''),
  })

  function addFiles(files: File[]) {
    if (!route) return
    for (const file of files.slice(0, 10 - uploads.length)) {
      const item: PendingUpload = {
        localId: `${Date.now()}-${Math.random()}`, file, progress: 0, result: null, abort: new AbortController(),
        error: null,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      }
      setUploads((list) => [...list, item])
      const update = (patch: Partial<PendingUpload>) => setUploads((list) => list.map((u) => (u.localId === item.localId ? { ...u, ...patch } : u)))
      uploadDmFile(route, target, file, (progress) => update({ progress }), item.abort.signal)
        .then((result) => update({ result, progress: 1 }))
        .catch((e: Error) => e.name !== 'AbortError' && update({ error: dmErrorText(e) }))
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
    if (!canSend) {
      if (canQueue) queue.queue()
      return
    }
    const files = uploads.filter((u) => u.result && u.result.server === ready[0]?.server)
      .map((u) => (u.spoiler && !isSpoilerName(u.result!.name) ? { ...u.result!, name: `SPOILER_${u.result!.name}` } : u.result!))
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview)
    setUploads([])
    setText('')
    void send(text.trim(), files)
  }

  async function sendVoice(recording: Recording) {
    if (!route) throw new Error(t('dms.errors.noSharedServer'))
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
              {!u.error && <SpoilerToggle on={!!u.spoiler} onToggle={() => setUploads((list) => list.map((x) => (x.localId === u.localId ? { ...x, spoiler: !x.spoiler } : x)))} />}
              {u.error
                ? <span className="upload-error" role="alert">{u.error}</span>
                : <span className="muted">{u.result ? formatSize(u.file.size) : formatNumber(u.progress, { style: 'percent', maximumFractionDigits: 0 })}</span>}
              {!u.result && !u.error && <span className="upload-progress" style={{ width: `${u.progress * 100}%` }} />}
              <button className="icon-button small" onClick={() => removeUpload(u)} aria-label={t('chat.composer.removeFile', { name: u.file.name })}><Close size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {queue.bar}
      <div className="composer">
        <button className="icon-button attach-button" onClick={() => fileInput.current?.click()} aria-label={t('chat.composer.attach')} title={t('dms.files.attachTitle')}>
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
          ref={box}
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); caret.current = e.target.selectionStart }}
          onSelect={(e) => { caret.current = e.currentTarget.selectionStart }}
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
        {/* Standard emoji only: custom ones belong to a server, and the other side may not share it. */}
        <button className="icon-button attach-button" onClick={(e) => setPicker(e.currentTarget)} aria-label={t('chat.composer.emoji')} title={t('chat.composer.emoji')}>
          <Smile />
        </button>
        {!text.trim() && uploads.length === 0 && voiceRecordingSupported() && <VoiceRecordButton onSend={sendVoice} disabled={!route} />}
        {later.button}
        <button className="send-button" onClick={submit} disabled={!canSend && !canQueue} aria-label={t('common.send')} {...later.sendProps}>
          <Send />
        </button>
      </div>
      {later.dialog}
      {picker && (
        <EmojiPicker
          serverKey=""
          anchor={picker}
          keepOpen
          onClose={() => {
            setPicker(null)
            const el = box.current
            if (!el) return
            el.focus()
            const at = caret.current ?? el.value.length
            el.setSelectionRange(at, at)
          }}
          onPick={(value) => {
            const next = insertAt(text, caret.current ?? text.length, value)
            setText(next.text)
            caret.current = next.caret
          }}
        />
      )}
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
  const [state, setState] = useState<{ opened: OpenedFile | null; error: string | null; busy: boolean; progress: number }>(
    { opened: null, error: null, busy: false, progress: 0 })
  const open = () => {
    setState((s) => ({ ...s, busy: true, error: null, progress: 0 }))
    openDmFile(file, (progress) => setState((s) => ({ ...s, progress }))).then(
      (opened) => setState({ opened, error: null, busy: false, progress: 1 }),
      (e: Error) => setState({ opened: null, error: e.message ? dmErrorText(e) : translate('dms.files.openFailed'), busy: false, progress: 0 }),
    )
  }
  useEffect(() => {
    if (auto) open()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.server, file.id, auto])
  return { ...state, open }
}

/** Saving straight to disk (desktop app, or a browser with a save picker): progress, cancel, and only "Saved" once checked. */
function useSave(file: DmFile) {
  const [state, setState] = useState<{ busy: boolean; progress: number; saved: boolean; error: string | null }>(
    { busy: false, progress: 0, saved: false, error: null })
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const save = () => {
    const controller = new AbortController()
    abort.current = controller
    setState({ busy: true, progress: 0, saved: false, error: null })
    saveDmFile(file, shownName(file.name), (progress) => setState((s) => ({ ...s, progress })), controller.signal).then(
      (result) => setState({ busy: false, progress: 0, saved: result === 'saved', error: null }),
      (e: Error) => setState({ busy: false, progress: 0, saved: false, error: e.name === 'AbortError' ? null : e.message ? dmErrorText(e) : translate('dms.files.saveFailed') }),
    )
  }
  return { ...state, save, cancel: () => abort.current?.abort() }
}

const percent = (fraction: number) => formatNumber(fraction, { style: 'percent', maximumFractionDigits: 0 })

function DmAttachment({ file }: { file: DmFile }) {
  const media = file.voice || /^(image|video|audio)\//.test(file.type)
  const { opened, error, busy, progress, open } = useOpened(file, !!media && file.size <= AUTO_OPEN_BYTES)
  const saving = useSave(file)
  const [zoom, setZoom] = useState(false)
  const { t } = useTranslation()

  if (file.voice) {
    if (error) return <div className="message-notice"><Lock size={13} /> {error} <button className="link" onClick={open}>{t('common.retry')}</button></div>
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

  // Anything else (or not opened yet): a file row. Where the platform allows, Save streams it to disk; elsewhere it is
  // decrypted into memory first and then saved under its name.
  const toDisk = canStreamToDisk()
  const working = busy || saving.busy
  return (
    <div className={`attachment-file dm-file ${working ? 'working' : ''}`}>
      <span className="file-icon" aria-hidden><FileIcon size={22} /></span>
      <span className="file-name">{shownName(file.name)}</span>
      <span className="muted">
        {saving.busy ? `${t('dms.files.saving')} ${percent(saving.progress)}`
          : busy ? `${t('dms.files.decrypting')} ${percent(progress)}`
            : saving.saved ? t('dms.files.saved') : formatSize(file.size)}
      </span>
      {saving.busy ? (
        <button className="button small" onClick={saving.cancel}>{t('common.cancel')}</button>
      ) : (
        <>
          {opened ? (
            <a className="button small" href={opened.url} download={shownName(file.name)}>{t('common.save')}</a>
          ) : (!toDisk || media) && (
            <button className="button small" disabled={busy} onClick={open}>{toDisk ? t('common.open') : t('common.download')}</button>
          )}
          {toDisk && !opened && <button className="button small" disabled={busy} onClick={saving.save}>{t('common.save')}</button>}
        </>
      )}
      {working && <span className="upload-progress" style={{ width: `${(saving.busy ? saving.progress : progress) * 100}%` }} />}
      {!toDisk && !opened && file.size > IN_MEMORY_NOTE_BYTES && <span className="muted dm-file-note">{t('dms.files.inMemory')}</span>}
      {(error || saving.error) && <span className="error-text dm-file-error" role="alert">{saving.error ?? error}</span>}
    </div>
  )
}
