// Iskra bot SDK. See docs/bots.md.
export {
  Bot, rejectionHelp,
  type BotOptions, type CommandContext, type CommandHandler, type IncomingMessage, type OutgoingFile, type PollOptions, type SendOptions,
} from './bot'
export { identityOf, loadState, newState, saveState, type BotState } from './state'
export { parseCommand, type Command } from '../../../client/src/core/commands'
export type { Channel, Embed, Events, FileInfo, Member, Message, Poll, Requests, ServerEvent, Thread, WebhookPost } from '../../../client/src/core/protocol'
export { RequestError } from '../../../client/src/core/protocol'
