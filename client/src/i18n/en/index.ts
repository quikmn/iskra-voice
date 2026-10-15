// The English catalog: the source of truth for every key. Each area is its own file.
import { common } from './common'
import { errors } from './errors'
import { app } from './app'
import { voice } from './voice'
import { presence } from './presence'
import { chat } from './chat'
import { dms } from './dms'
import { settings } from './settings'
import { profile } from './profile'
import { keys } from './keys'
import { organize } from './organize'
import { moderation } from './moderation'
import { roles } from './roles'
import { rules } from './rules'
import { automod } from './automod'
import { events } from './events'
import { forums } from './forums'
import { calls } from './calls'
import { groups } from './groups'
import { stage } from './stage'
import { watch } from './watch'
import { expressions } from './expressions'
import { friends } from './friends'
import { account } from './account'
import { safety } from './safety'
import { productivity } from './productivity'
import { docs } from './docs'
import { catchup } from './catchup'
import { compliance } from './compliance'
import { updates } from './updates'
import { clips } from './clips'
import { e2ee } from './e2ee'
import { media } from './media'
import { hosting } from './hosting'
import { outhooks } from './outhooks'
import { builtinBots } from './builtinBots'
import { rental } from './rental'
import { bugReport } from './bugReport'
import { afk } from './afk'
import { whatsNew } from './whatsNew'
import { claim } from './claim'
import { templates } from './templates'
import { translate } from './translate'

export const en = {
  common,
  errors,
  app,
  voice,
  presence,
  chat,
  dms,
  settings,
  profile,
  keys,
  organize,
  moderation,
  roles,
  rules,
  automod,
  events,
  forums,
  calls,
  groups,
  stage,
  watch,
  expressions,
  friends,
  account,
  safety,
  productivity,
  docs,
  catchup,
  compliance,
  updates,
  clips,
  e2ee,
  media,
  hosting,
  outhooks,
  builtinBots,
  rental,
  bugReport,
  afk,
  whatsNew,
  claim,
  templates,
  translate,
} as const
