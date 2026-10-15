// A channel's topic: one line under the header saying what the channel is for. Tap it to read all of it.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import './topic.css'

export function ChannelTopic({ channel }: { channel: Channel | undefined }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const topic = channel?.topic?.trim()
  if (!topic) return null
  return (
    <button
      type="button"
      className={`channel-topic ${open ? 'open' : ''}`}
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      aria-label={`${t('chat.header.topic')}: ${topic}`}
      title={open ? t('chat.header.topicLess') : t('chat.header.topicMore')}
    >
      <span className="channel-topic-text">{topic}</span>
    </button>
  )
}
