// "/" at the start of the composer suggests the bot commands that work in this channel: bot, command, description,
// then hints for its options as you type. Arrows move, Tab/Enter complete, Esc closes. Sending posts plain text, except
// to bots that take interactions: then the command and its options go to the bot (trySend).
import { useId, useState, type AriaAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { interactiveCommand, useBotCommands, useChannelCommands } from '../../state/botCommands'
import { invoke } from '../../state/interactions'
import { useServerRoles } from '../../state/roles'
import { useApp } from '../../state/store'
import { Avatar } from '../bits'
import { encodeMentions } from '../markdown'
import { parseOptions } from './commandInvoke'
import {
  activeOption, commandQueryAt, commandTarget, completeChoice, completeCommand, findCommand, matchChoices, matchCommands, signature,
} from './commandMatch'
import './commands.css'

interface Suggest {
  open: boolean
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  popup: ReactNode
  /** For the textarea: it controls the list while it's open. */
  inputProps: AriaAttributes
  /**
   * Sends a command to a bot that takes interactions: 'sent' (clear the composer), 'blocked' (an option is missing or
   * wrong: keep the text, the hint says why), or null (not such a command: send the text as a message).
   */
  trySend: (text: string) => 'sent' | 'blocked' | null
}

export function useCommandSuggest(
  serverKey: string, channelId: number, encrypted: boolean, text: string, caret: number,
  apply: (next: { text: string; caret: number }) => void,
): Suggest {
  const { t } = useTranslation()
  const id = useId()
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const query = commandQueryAt(text, caret)
  const entries = useChannelCommands(serverKey, channelId, query !== null, encrypted)
  const hasBots = useBotCommands((s) => Object.keys(s.lists[serverKey] ?? {}).length > 0)
  const closed = dismissed === text
  const members = useApp((s) => s.servers[serverKey]?.members)
  const channels = useApp((s) => s.servers[serverKey]?.channels)
  const roles = useServerRoles(serverKey)
  // Why the last command couldn't be sent, shown until the text changes.
  const [failure, setFailure] = useState<{ text: string; message: string } | null>(null)
  if (failure && failure.text !== text) setFailure(null)
  // Encrypted channels where no bot can answer (only bots that take interactions can, privately): say why nothing is suggested.
  const encryptedHint = encrypted && hasBots && query?.kind === 'name' && !closed && entries.length === 0
  // Esc closes the list for this text only: once the text changes, typing "/" again opens it again.
  if (dismissed !== null && dismissed !== text) setDismissed(null)

  // Name mode: matching commands. Args mode: the command's signature, plus its choices for the option being typed.
  const names = query?.kind === 'name' && !closed ? matchCommands(entries, query.query, query.target) : []
  const command = query?.kind === 'args' ? findCommand(entries, query.name, query.target) : null
  const active = command && query?.kind === 'args' ? activeOption(command.command, query.args) : null
  const choices = active && !closed ? matchChoices(active.option, active.word).slice(0, 8) : []
  const count = names.length || choices.length
  const current = count ? pick % count : 0
  const listId = `${id}-list`
  const optionId = (i: number) => `${id}-opt-${i}`
  const hintId = `${id}-hint`

  const chooseName = (i: number) => {
    const next = completeCommand(names[i], entries)
    apply({ text: next, caret: next.length })
    setPick(0)
  }
  const chooseChoice = (i: number) => {
    const next = completeChoice(text, active!.word, choices[i].value)
    apply({ text: next, caret: next.length })
    setPick(0)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key === 'Escape' && (count > 0 || (command && !closed) || encryptedHint)) {
      e.preventDefault()
      setDismissed(text)
      return true
    }
    if (!count) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
      e.preventDefault()
      if (names.length) chooseName(current)
      else chooseChoice(current)
      return true
    }
    return false
  }

  const trySend = (raw: string): 'sent' | 'blocked' | null => {
    const q = commandQueryAt(raw, raw.length)
    if (!q) return null
    const name = q.kind === 'name' ? q.query : q.name
    const listed = findCommand(entries, name, q.target)
    const entry = commandTarget(listed, encrypted, closed, () => interactiveCommand(serverKey, name, q.target, (k) => members?.[k]?.name))
    if (!entry) return null
    const memberList = Object.values(members ?? {})
    const args = encodeMentions(q.kind === 'args' ? q.args : '', memberList, roles)
    const parsed = parseOptions(entry.command, args, { members: memberList, channels: channels ?? [], roles })
    if (!parsed.ok) {
      const option = entry.command.options?.find((o) => o.name === parsed.option)
      const values = { option: parsed.option, type: t(`chat.bot.type.${option?.type ?? 'string'}`), description: option?.description ?? '' }
      setFailure({ text: raw, message: t(parsed.reason === 'missing' ? 'chat.interaction.missing' : 'chat.interaction.invalid', values) })
      return 'blocked'
    }
    const typed = q.kind === 'args' ? q.args.trim() : ''
    invoke(serverKey, channelId, entry.bot, `/${entry.command.name}`, {
      bot: entry.bot, channelId, command: entry.command.name, options: parsed.options, ...(typed ? { args: typed } : {}),
    }).catch((e: unknown) => {
      // Refused (offline bot, not allowed): put the command back so it isn't lost.
      apply({ text: raw, caret: raw.length })
      setFailure({ text: raw, message: errorMessage(e) })
    })
    return 'sent'
  }

  const e2eeNote = encrypted ? <div className="command-e2ee-note" role="note">{t('chat.interaction.e2eeNote')}</div> : null
  let popup: ReactNode = null
  if (failure) {
    popup = <div className="mention-popup command-hint" role="alert"><div className="command-signature">{failure.message}</div></div>
  } else if (names.length > 0) {
    popup = (
      <div className="mention-popup command-suggest">
        {e2eeNote}
        <div id={listId} role="listbox" aria-label={t('chat.bot.commands')}>
        {names.map((entry, i) => (
          <div
            key={`${entry.bot}/${entry.command.name}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === current}
            className={`command-option ${i === current ? 'active' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault()
              chooseName(i)
            }}
          >
            <Avatar name={entry.botName} accountKey={entry.bot} size={24} />
            <span className="command-main">
              <span className="command-name">/{entry.command.name}</span>
              {(entry.command.usage || entry.command.options?.length) ? <span className="command-usage">{signature(entry.command).slice(entry.command.name.length + 2)}</span> : null}
              <span className="command-description">{entry.command.description}</span>
            </span>
            <span className="command-bot">{entry.botName}</span>
          </div>
        ))}
        </div>
      </div>
    )
  } else if (command && !closed) {
    const options = command.command.options ?? []
    popup = (
      <div className="mention-popup command-hint">
        {e2eeNote}
        <div className="command-signature" id={hintId}>
          <Avatar name={command.botName} accountKey={command.bot} size={20} />
          <span className="command-name">/{command.command.name}</span>
          {command.command.usage && <span className="command-usage">{command.command.usage}</span>}
          {!command.command.usage && options.map((o, i) => (
            <span key={o.name} className={`command-param ${active?.index === i ? 'current' : ''}`}>{o.required ? `<${o.name}>` : `[${o.name}]`}</span>
          ))}
          {active && (
            <span className="command-param-help">
              {active.option.name} ({t(`chat.bot.type.${active.option.type}`)}, {t(active.option.required ? 'chat.bot.required' : 'chat.bot.optional')}): {active.option.description}
            </span>
          )}
          {!active && <span className="command-param-help">{command.command.description}</span>}
        </div>
        {choices.length > 0 && (
          <div id={listId} role="listbox" aria-label={t('chat.bot.choices', { name: active!.option.name })}>
            {choices.map((choice, i) => (
              <div
                key={String(choice.value)}
                id={optionId(i)}
                role="option"
                aria-selected={i === current}
                className={`command-option ${i === current ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  chooseChoice(i)
                }}
              >
                <span className="command-name">{String(choice.value)}</span>
                {choice.name !== String(choice.value) && <span className="command-description">{choice.name}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (!popup && encryptedHint) {
    popup = (
      <div className="mention-popup command-hint" id={hintId}>
        <div className="command-signature"><span className="command-param-help">{t('builtinBots.encryptedHint')}</span></div>
      </div>
    )
  }

  const inputProps: AriaAttributes = count > 0
    ? { 'aria-autocomplete': 'list', 'aria-controls': listId, 'aria-activedescendant': optionId(current), 'aria-describedby': command ? hintId : undefined }
    : (command && !closed) || encryptedHint ? { 'aria-describedby': hintId } : {}
  return { open: popup !== null, onKeyDown, popup, inputProps, trySend }
}
