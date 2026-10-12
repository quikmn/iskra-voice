// Back in voice after a drop: camera and screen share stayed off (on purpose); one tap turns them on again.
import { useTranslation } from 'react-i18next'
import { canShareScreen, dismissResumeOffer, toggleCamera, toggleScreenShare, useVoice } from '../state/voice'
import { Camera, ScreenShare } from './icons'
import './restart.css'

export function ResumeOffer() {
  const { t } = useTranslation()
  const offer = useVoice((s) => s.resumeOffer)
  const canSpeak = useVoice((s) => !!s.session?.canSpeak)
  const screen = !!offer?.screen && canShareScreen()
  if (!offer || !canSpeak || (!screen && !offer.camera)) return null
  return (
    <div className="resume-offer" role="status">
      <p>{t('voice.resume.note')}</p>
      {screen && (
        <button className="button primary small" onClick={() => void toggleScreenShare()}>
          <ScreenShare size={16} /> {t('voice.resume.shareAgain')}
        </button>
      )}
      {offer.camera && (
        <button className="button small" onClick={() => void toggleCamera()}>
          <Camera size={16} /> {t('voice.resume.cameraAgain')}
        </button>
      )}
      <button className="button small ghost" onClick={dismissResumeOffer}>{t('voice.resume.dismiss')}</button>
    </div>
  )
}
