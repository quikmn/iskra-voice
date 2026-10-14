// "/" in a DM with a bot suggests its commands, like in a channel. Here the command is just the DM's text: it goes to the
// bot end-to-end encrypted, and the bot answers with DMs (no private answers, forms or buttons in DMs).
import { useId, useMemo, useState, type AriaAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BotCommand } from '../../core/protocol'
import { useBotCommands } from '../../state/botCommands'
import { useApp } from '../../state/store'
import { mayUse } from '../chat/commandInvoke'
import {
  activeOption, commandQueryAt, completeChoice, completeCommand, findCommand, matchChoices, matchCommands, signature, type CommandEntry,
} from '../chat/commandMatch'
import '../chat/commands.css'

/**
 * The bot's commands someone can use in a DM: from a server you share with it, the ones your role there allows. Commands
 * that need a permission only work in channels (the bot can't check permissions in a DM), so they're left out.
 */
export function dmCommands(lists: BotCommand[] | undefined, role: Parameters<typeof mayUse>[1]): BotCommand[] {
  return (lists ?? []).filter((c) => !c.permission && mayUse(c, role, () => false))
}

export function useBotDmCommands(peer: string, enabled: boolean, text: string, caret: number, apply: (next: { text: string; caret: number }) => void): {
  popup: ReactNode
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  inputProps: AriaAttributes
} {
  const { t } = useTranslation()
  const id = useId()
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (dismissed !== null && dismissed !== text) setDismissed(null)
  const lists = useBotCommands((s) => s.lists)
  const servers = useApp((s) => s.servers)

  const entries = useMemo((): CommandEntry[] => {
    if (!enabled) return []
    for (const [key, server] of Object.entries(servers)) {
      const member = server.members[peer]
      const commands = dmCommands(lists[key]?.[peer], server.me)
      if (member?.bot && commands.length) return commands.map((command) => ({ bot: peer, botName: member.name, command }))
    }
    return []
  }, [enabled, servers, lists, peer])

  const closed = dismissed === text
  const query = enabled && !closed ? commandQueryAt(text, caret) : null
  const names = query?.kind === 'name' ? matchCommands(entries, query.query, query.target) : []
  const command = query?.kind === 'args' ? findCommand(entries, query.name, query.target) : null
  const active = command && query?.kind === 'args' ? activeOption(command.command, query.args) : null
  const choices = active ? matchChoices(active.option, active.word).slice(0, 8) : []
  const count = names.length || choices.length
  const current = count ? pick % count : 0
  const listId = `${id}-list`
  const hintId = `${id}-hint`
  const optionId = (i: number) => `${id}-opt-${i}`

  const choose = (i: number) => {
    const next = names.length ? completeCommand(names[i], entries) : completeChoice(text, active!.word, choices[i].value)
    apply({ text: next, caret: next.length })
    setPick(0)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key === 'Escape' && (count > 0 || command)) {
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
      choose(current)
      return true
    }
    return false
  }

  let popup: ReactNode = null
  if (names.length > 0) {
    popup = (
      <div className="mention-popup command-suggest">
        <div id={listId} role="listbox" aria-label={t('chat.bot.commands')}>
          {names.map((entry, i) => (
            <div key={entry.command.name} id={optionId(i)} role="option" aria-selected={i === current}
              className={`command-option ${i === current ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(i)
              }}>
              <span className="command-main">
                <span className="command-name">/{entry.command.name}</span>
                {(entry.command.usage || entry.command.options?.length) ? <span className="command-usage">{signature(entry.command).slice(entry.command.name.length + 2)}</span> : null}
                <span className="command-description">{entry.command.description}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  } else if (command) {
    const options = command.command.options ?? []
    popup = (
      <div className="mention-popup command-hint">
        <div className="command-signature" id={hintId}>
          <span className="command-name">/{command.command.name}</span>
          {command.command.usage && <span className="command-usage">{command.command.usage}</span>}
          {!command.command.usage && options.map((o, i) => (
            <span key={o.name} className={`command-param ${active?.index === i ? 'current' : ''}`}>{o.required ? `<${o.name}>` : `[${o.name}]`}</span>
          ))}
          <span className="command-param-help">
            {active
              ? `${active.option.name} (${t(`chat.bot.type.${active.option.type}`)}, ${t(active.option.required ? 'chat.bot.required' : 'chat.bot.optional')}): ${active.option.description}`
              : command.command.description}
          </span>
        </div>
        {choices.length > 0 && (
          <div id={listId} role="listbox" aria-label={t('chat.bot.choices', { name: active!.option.name })}>
            {choices.map((choice, i) => (
              <div key={String(choice.value)} id={optionId(i)} role="option" aria-selected={i === current}
                className={`command-option ${i === current ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(i)
                }}>
                <span className="command-name">{String(choice.value)}</span>
                {choice.name !== String(choice.value) && <span className="command-description">{choice.name}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const inputProps: AriaAttributes = count > 0
    ? { 'aria-autocomplete': 'list', 'aria-controls': listId, 'aria-activedescendant': optionId(current), 'aria-describedby': command ? hintId : undefined }
    : command ? { 'aria-describedby': hintId } : {}
  return { popup, onKeyDown, inputProps }
}
