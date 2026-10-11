// Pure helpers for voice user limits and server rules (unit-tested; no React or sockets here).
import type { ServerRules } from '../core/protocol'
import { t } from '../i18n'

export const MAX_USER_LIMIT = 99
export const MAX_RULES_LENGTH = 6000
export const MAX_WELCOME_LENGTH = 500

/** "2/5" next to a voice channel with a limit; null without one. */
export function limitLabel(count: number, limit: number | undefined): string | null {
  return limit && limit > 0 ? `${count}/${limit}` : null
}

/** Full for you: at the limit, and you can't move members (who join anyway). */
export function isFull(count: number, limit: number | undefined, bypass: boolean): boolean {
  return !bypass && !!limit && limit > 0 && count >= limit
}

/** Clamps whatever was typed into 0–99 (0 = no limit). */
export function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(MAX_USER_LIMIT, Math.max(0, Math.round(value)))
}

/** Show the welcome screen by itself once per rules version, until agreed (closing it waits for the next version). */
export function shouldAutoOpen(rules: ServerRules | undefined, dismissedVersion: number | undefined): boolean {
  return !!rules?.mustAgree && dismissedVersion !== rules.version
}

export const hasRules = (rules: ServerRules | undefined) => !!rules && rules.text.trim().length > 0

export interface RulesDraft {
  text: string
  welcome: string
  required: boolean
  /** Turning on: also ask people already here. Already on: ask everyone again. */
  askEveryone: boolean
}

/** The rules.update body for a draft, and the question to ask about who must agree (null when none applies). */
export function rulesUpdate(current: ServerRules | undefined, draft: RulesDraft): {
  body: { text: string; welcome: string; required: boolean; reaccept: boolean }
  question: 'existing' | 'again' | null
} {
  const wasRequired = !!current?.required
  const question = !draft.required ? null : wasRequired ? 'again' : 'existing'
  return {
    body: { text: draft.text.trim(), welcome: draft.welcome.trim(), required: draft.required, reaccept: draft.required && draft.askEveryone },
    question,
  }
}

/** Can the draft be saved? Returns why not, or null. */
export function rulesProblem(draft: RulesDraft): string | null {
  if (draft.text.trim().length > MAX_RULES_LENGTH) return t('rules.problems.rulesTooLong', { max: MAX_RULES_LENGTH })
  if (draft.welcome.trim().length > MAX_WELCOME_LENGTH) return t('rules.problems.welcomeTooLong', { max: MAX_WELCOME_LENGTH })
  if (draft.required && !draft.text.trim()) return t('rules.problems.writeFirst')
  return null
}
