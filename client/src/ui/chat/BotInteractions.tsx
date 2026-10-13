// Bot interactions in the chat: buttons and select menus on bots' messages, the "Viktor used /roll" line, and the tray
// above the composer with "Dice is thinking…" and private answers (only you see them), plus a bot's form.
// Everything a bot sends is rendered as text by React, never as HTML.
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentButton, ComponentRow, ComponentSelect, InteractionInvoke, Message } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { click, closeForm, dismissAnswer, dismissPending, submitForm, useInteractions, type OpenForm } from '../../state/interactions'
import { channelKey, pendingIn } from '../../state/interactionsLogic'
import type { PendingMessage, ServerState } from '../../state/store'
import { Avatar, Modal, Spinner } from '../bits'
import { renderMarkdown } from '../markdown'
import { BotBadge, Embeds } from './BotBits'
import { BuiltinReply } from './BuiltinReply'
import { safeUrl } from './bots'
import './interactions.css'

type Target = { messageId: number } | { responseId: string }

/** A bot's buttons and menus; clicks become interactions. */
export function ComponentRows({ server, channelId, bot, rows, target }: {
  server: ServerState
  channelId: number
  bot: string
  rows: ComponentRow[]
  target: Target
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<string | null>(null)
  const botName = server.members[bot]?.name ?? ''
  const send = async (customId: string, label: string, values?: string[]) => {
    setBusy(customId)
    try {
      await click(server.key, channelId, bot, label, { ...target, customId, ...(values ? { values } : {}) } as InteractionInvoke)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="bot-components" role="group" aria-label={t('chat.interaction.buttons', { bot: botName })}>
      {rows.map((row, i) => (
        <div key={i} className="bot-component-row">
          {row.items.map((item, j) => item.type === 'button'
            ? <BotButton key={j} button={item} busy={busy === item.customId} onClick={() => item.customId && void send(item.customId, item.label)} />
            : <BotSelect key={j} select={item as ComponentSelect} busy={busy === (item as ComponentSelect).customId} onPick={(values, label) => void send((item as ComponentSelect).customId, label, values)} />)}
        </div>
      ))}
    </div>
  )
}

function BotButton({ button, busy, onClick }: { button: ComponentButton; busy: boolean; onClick: () => void }) {
  const { t } = useTranslation()
  const style = button.style ?? 'secondary'
  if (style === 'link') {
    // Opened only when clicked, and the address is shown first.
    const url = safeUrl(button.url)
    if (!url) return null
    const host = new URL(url).host
    return (
      <a className="bot-button link" href={url} target="_blank" rel="noopener noreferrer nofollow" title={t('chat.interaction.opens', { url })}>
        {button.label} <span className="bot-button-host">{host}</span>
      </a>
    )
  }
  return (
    <button type="button" className={`bot-button ${style}`} disabled={button.disabled || busy} aria-busy={busy || undefined} onClick={onClick}>
      {button.label}
    </button>
  )
}

function BotSelect({ select, busy, onPick }: { select: ComponentSelect; busy: boolean; onPick: (values: string[], label: string) => void }) {
  const { t } = useTranslation()
  const max = select.maxValues ?? 1
  const min = select.minValues ?? 1
  const [picked, setPicked] = useState<string[]>(() => select.options.filter((o) => o.default).map((o) => o.value))
  const labelOf = (values: string[]) => select.options.filter((o) => values.includes(o.value)).map((o) => o.label).join(', ')
  if (max === 1) {
    return (
      <select className="bot-select" disabled={select.disabled || busy} value="" aria-label={select.placeholder ?? t('chat.interaction.choose')}
        onChange={(e) => e.target.value && onPick([e.target.value], labelOf([e.target.value]))}>
        <option value="" disabled>{select.placeholder ?? t('chat.interaction.choose')}</option>
        {select.options.map((o) => <option key={o.value} value={o.value} title={o.description}>{o.label}</option>)}
      </select>
    )
  }
  const toggle = (value: string, on: boolean) =>
    setPicked((list) => (on ? (list.length < max ? [...list, value] : list) : list.filter((v) => v !== value)))
  return (
    <fieldset className="bot-multiselect" disabled={select.disabled || busy}>
      <legend>{select.placeholder ?? t('chat.interaction.pickUpTo', { max })}</legend>
      {select.options.map((o) => (
        <label key={o.value} className="checkbox">
          <input type="checkbox" checked={picked.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
          <span>{o.label}{o.description && <span className="muted"> · {o.description}</span>}</span>
        </label>
      ))}
      <button type="button" className="button small" disabled={picked.length < min || picked.length > max} onClick={() => onPick(picked, labelOf(picked))}>
        {t('chat.interaction.send')}
      </button>
    </fieldset>
  )
}

/** On a bot's message: its components, if it has any. */
export function MessageComponents({ server, message }: { server: ServerState; message: PendingMessage }) {
  if (!message.components?.length || message.tempId) return null
  return <ComponentRows server={server} channelId={message.channelId} bot={message.author} rows={message.components} target={{ messageId: message.id }} />
}

/** Above a bot's public answer: who asked, and with which command. */
export function InteractionLine({ server, message }: { server: ServerState; message: Message }) {
  const { t } = useTranslation()
  if (!message.interaction) return null
  const name = server.members[message.interaction.user]?.name ?? t('chat.author.formerMember')
  return (
    <div className="interaction-line">
      {message.interaction.command
        ? t('chat.interaction.used', { name, command: `/${message.interaction.command}` })
        : t('chat.interaction.answered', { name })}
    </div>
  )
}

/** Above the composer: what's waiting for a bot, private answers, and a bot's form. */
export function InteractionTray({ server, channelId }: { server: ServerState; channelId: number }) {
  const { t } = useTranslation()
  const pending = useInteractions((s) => s.pending)
  const answers = useInteractions((s) => s.answers[channelKey(server.key, channelId)])
  const form = useInteractions((s) => s.form)
  const waiting = pendingIn(pending, server.key, channelId)
  const nameOf = (key: string) => server.members[key]?.name ?? ''
  const ctx = { nameOf: (k: string) => server.members[k]?.name ?? null, me: server.me?.accountKey }
  if (!waiting.length && !answers?.length && !(form?.serverKey === server.key && form.channelId === channelId)) return null
  return (
    <div className="interaction-tray">
      {answers?.map((answer) => (
        <article key={answer.responseId} className="private-answer" aria-label={t('chat.interaction.onlyYou')}>
          <header>
            <Avatar name={nameOf(answer.bot)} accountKey={answer.bot} size={20} />
            <strong>{nameOf(answer.bot)}</strong> <BotBadge />
            <span className="private-label">{t('chat.interaction.onlyYou')}</span>
            <button type="button" className="link" onClick={() => dismissAnswer(server.key, channelId, answer.responseId)}>{t('chat.interaction.dismiss')}</button>
          </header>
          {answer.builtin
            ? <BuiltinReply server={server} reply={answer.builtin} />
            : answer.text && <div className="message-text">{renderMarkdown(answer.text, ctx)}</div>}
          {answer.cards.length > 0 && <Embeds server={server} embeds={answer.cards} authorName={nameOf(answer.bot)} />}
          {answer.components.length > 0 && (
            <ComponentRows server={server} channelId={channelId} bot={answer.bot} rows={answer.components} target={{ responseId: answer.responseId }} />
          )}
        </article>
      ))}
      {waiting.map(([id, p]) => (
        <div key={id} className={`interaction-pending ${p.state}`} role="status">
          {p.state === 'failed' ? (
            <>
              <span>{p.error ? t('chat.interaction.failed', { bot: nameOf(p.bot), error: p.error }) : t('chat.interaction.noAnswer', { bot: nameOf(p.bot) })}</span>
              <button type="button" className="link" onClick={() => dismissPending(id)}>{t('chat.interaction.dismiss')}</button>
            </>
          ) : (
            <><Spinner /> <span>{t('chat.interaction.thinking', { bot: nameOf(p.bot) })}</span> <span className="muted">{p.label}</span></>
          )}
        </div>
      ))}
      {form?.serverKey === server.key && form.channelId === channelId && <BotForm form={form} botName={nameOf(form.bot)} />}
    </div>
  )
}

function BotForm({ form, botName }: { form: OpenForm; botName: string }) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.modal.fields.map((f) => [f.customId, f.value ?? ''])))
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setSending(true)
    try {
      await submitForm(form, values)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }
  return (
    <Modal title={form.modal.title} onClose={closeForm}
      footer={<button className="button primary" type="submit" form={`bot-form-${form.modalId}`} disabled={sending}>{t('chat.interaction.send')}</button>}>
      <form id={`bot-form-${form.modalId}`} className="bot-form" onSubmit={(e) => void submit(e)}>
        <p className="muted">{t('chat.interaction.formFrom', { bot: botName })}</p>
        {form.modal.fields.map((field) => (
          <label key={field.customId} className="field">
            <span>{field.label}{field.required === false && <span className="muted"> ({t('chat.interaction.optionalField')})</span>}</span>
            {field.style === 'paragraph' ? (
              <textarea rows={4} maxLength={field.maxLength} placeholder={field.placeholder} required={field.required !== false}
                value={values[field.customId] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [field.customId]: e.target.value }))} />
            ) : (
              <input maxLength={field.maxLength} placeholder={field.placeholder} required={field.required !== false}
                value={values[field.customId] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [field.customId]: e.target.value }))} />
            )}
          </label>
        ))}
        {error && <p className="error-text" role="alert">{error}</p>}
      </form>
    </Modal>
  )
}
