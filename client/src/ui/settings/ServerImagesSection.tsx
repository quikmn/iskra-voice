// Server settings → Overview: the server's icon and banner, for whoever has the serverImages power (admins by default).
// The picture is cropped and encoded on this device; the server checks it again and strips what metadata is left.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useServerBaseRoles } from '../../state/baseRoles'
import { baseAllows } from '../../state/permissions'
import { SERVER_IMAGE_LIMITS, setServerImage, useServerImage, type ServerImageKind } from '../../state/serverImages'
import type { ServerState } from '../../state/store'
import { errorMessage } from '../../i18n/errors'
import { AvatarCropper } from '../profile/AvatarCropper'
import { ServerTile } from './ServerTile'

export function ServerImagesSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const allowed = baseAllows(useServerBaseRoles(server.key), server.me, 'serverImages')
  const [status, setStatus] = useState<{ kind: 'saved' | 'error' | 'busy'; text: string } | null>(null)
  const [cropping, setCropping] = useState<{ kind: ServerImageKind; file: File } | null>(null)
  if (!allowed) return null

  async function apply(kind: ServerImageKind, image: Blob | null) {
    setCropping(null)
    setStatus({ kind: 'busy', text: t('settings.overview.uploading') })
    try {
      await setServerImage(server.key, kind, image)
      const done = kind === 'icon'
        ? image ? t('settings.overview.iconUpdated') : t('settings.overview.iconRemoved')
        : image ? t('settings.overview.bannerUpdated') : t('settings.overview.bannerRemoved')
      setStatus({ kind: 'saved', text: done })
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    }
  }

  const limits = cropping ? SERVER_IMAGE_LIMITS[cropping.kind] : null
  return (
    <div className="server-images" data-testid="server-images">
      <h3>{t('settings.overview.looks')}</h3>
      <p className="muted">{t('settings.overview.looksHint')}</p>
      <ImageRow server={server} kind="icon" busy={status?.kind === 'busy'} onPick={(file) => setCropping({ kind: 'icon', file })} onRemove={() => void apply('icon', null)} />
      <ImageRow server={server} kind="banner" busy={status?.kind === 'busy'} onPick={(file) => setCropping({ kind: 'banner', file })} onRemove={() => void apply('banner', null)} />
      {status && <p className={status.kind === 'error' ? 'error-text' : status.kind === 'saved' ? 'success-text' : 'muted'} role="status">{status.text}</p>}
      {cropping && limits && (
        <AvatarCropper
          file={cropping.file}
          shape={{ width: limits.width, height: limits.height, maxBytes: limits.maxBytes, round: cropping.kind === 'icon' }}
          title={cropping.kind === 'icon' ? t('settings.overview.cropIcon') : t('settings.overview.cropBanner')}
          confirm={t('settings.overview.use')}
          onCancel={() => setCropping(null)}
          onDone={(image) => void apply(cropping.kind, image)}
        />
      )}
    </div>
  )
}

function ImageRow({ server, kind, busy, onPick, onRemove }: {
  server: ServerState; kind: ServerImageKind; busy: boolean; onPick: (file: File) => void; onRemove: () => void
}) {
  const { t } = useTranslation()
  const url = useServerImage(server.key, kind)
  const input = useRef<HTMLInputElement>(null)
  const label = kind === 'icon' ? t('settings.overview.icon') : t('settings.overview.banner')
  return (
    <div className={`server-image-row ${kind}`}>
      <div className="server-image-preview">
        {kind === 'icon'
          ? <ServerTile server={server} />
          : url ? <img src={url} alt={server.name} /> : <span className="muted">{t('settings.overview.none')}</span>}
      </div>
      <div className="server-image-copy">
        <strong>{label}</strong>
        <span className="muted">{kind === 'icon' ? t('settings.overview.iconHint') : t('settings.overview.bannerHint')}</span>
        <div className="copy-row">
          <button className="button small" disabled={busy} onClick={() => input.current?.click()} data-testid={`server-${kind}-upload`}>
            {url ? t('settings.overview.change') : t('settings.overview.upload')}
          </button>
          {url && <button className="button small danger-outline" disabled={busy} onClick={onRemove} data-testid={`server-${kind}-remove`}>{t('common.remove')}</button>}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            aria-label={label}
            data-testid={`server-${kind}-file`}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) onPick(file)
            }}
          />
        </div>
      </div>
    </div>
  )
}
