// Group problems and unreadable-message notes are kept as the app (or core/group.ts) wrote them, in English:
// this shows them in the reader's language, and anything unknown (from the server, say) as it is.
import type { ParseKeys } from 'i18next'
import { MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS } from '../../core/group'
import { t } from '../../i18n'
import { en } from '../../i18n/en'
import { dmErrorText } from '../../state/dms'

let known: Map<string, ParseKeys> | null = null

function table(): Map<string, ParseKeys> {
  if (known) return known
  known = new Map()
  const vars = { min: MIN_GROUP_MEMBERS, max: MAX_GROUP_MEMBERS }
  for (const [id, text] of Object.entries(en.groups.problems)) {
    known.set(text.replace('{{min}}', String(vars.min)).replace('{{max}}', String(vars.max)), `groups.problems.${id}` as ParseKeys)
  }
  return known
}

export function groupText(text: string): string {
  const key = table().get(text)
  // Not a group text: maybe one of the DM encryption errors (core/dm.ts), else as it is.
  return key ? String(t(key, { min: MIN_GROUP_MEMBERS, max: MAX_GROUP_MEMBERS } as never)) : dmErrorText({ message: text })
}
