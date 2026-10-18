// Commands the app itself handles in the composer ("/teams", "/lfg"): listed with the bot commands, never sent to the
// server as text. Each opens a dialog; the server checks everything when that dialog acts.
import type { BotCommand } from '../../core/protocol'
import { t } from '../../i18n'
import { openLfg } from '../../state/lfg'
import { parseLfgArgs } from '../../state/lfgLogic'
import { askableGroups, openRolePicker, roleGroupsFor, rolesFor } from '../../state/roles'
import { useApp } from '../../state/store'
import { canSplit, openTeams } from '../../state/teams'
import { useVoice } from '../../state/voice'
import { ttsBlocked } from '../../state/speech'
import type { CommandEntry } from './commandMatch'

/** The "bot" an app command shows as. */
export const APP_BOT = 'iskra-app'

interface AppCommand {
  command: BotCommand
  /** Opens what it opens; returns why it can't (shown under the composer), or null. */
  run: (serverKey: string, channelId: number, args: string) => string | null
}

function commands(): AppCommand[] {
  return [
    {
      command: { name: 'teams', description: t('teams.command.description') },
      run: (serverKey, channelId) => {
        const server = useApp.getState().servers[serverKey]
        if (!server) return null
        if (!canSplit(server, rolesFor(serverKey))) return t('errors.server.teams_move')
        const here = server.channels.find((c) => c.id === channelId)
        const session = useVoice.getState().session
        const voice = here?.kind === 'voice' ? here.id : session?.serverKey === serverKey && !session.call && !session.group ? session.channelId : null
        if (voice === null) return t('teams.command.notInVoice')
        openTeams(serverKey, voice)
        return null
      },
    },
    {
      command: { name: 'lfg', description: t('lfg.command.description'), usage: t('lfg.command.usage') },
      run: (serverKey, channelId, args) => {
        const channel = useApp.getState().servers[serverKey]?.channels.find((c) => c.id === channelId)
        if (!channel || channel.kind !== 'text' || channel.e2ee) return t('errors.server.lfg_channel')
        const { slots, game } = parseLfgArgs(args)
        openLfg(serverKey, channelId, game, slots)
        return null
      },
    },
    {
      // Sent by the composer when it can be (ChatView): this only says why it can't.
      command: { name: 'tts', description: t('speech.tts.description'), usage: t('speech.tts.usage') },
      run: (serverKey, _channelId, args) => ttsBlocked(serverKey, args.trim()),
    },
    {
      command: { name: 'roles', description: t('joinQuestions.flow.command') },
      run: (serverKey) => {
        if (askableGroups(roleGroupsFor(serverKey), rolesFor(serverKey)).length === 0) return t('joinQuestions.flow.none')
        openRolePicker(serverKey)
        return null
      },
    },
  ]
}

/** The app's commands as suggestion entries. */
export const appEntries = (): CommandEntry[] =>
  commands().map((c) => ({ bot: APP_BOT, botName: 'Iskra', command: c.command, app: true }))

/** Runs an app command by name: undefined when there's no such command, else null or why it couldn't. */
export function runAppCommand(serverKey: string, channelId: number, name: string, args: string): string | null | undefined {
  const command = commands().find((c) => c.command.name === name)
  return command ? command.run(serverKey, channelId, args) : undefined
}
