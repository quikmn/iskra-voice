// What to tell the person when a passkey didn't work (shared by the lock screen and Settings).
import { PasskeyError, problemOf, type PasskeyProblem } from '../../platform/passkeys'

const PROBLEMS = {
  unsupported: 'keys.passkeys.problems.unsupported',
  'no-prf': 'keys.passkeys.problems.noPrf',
  cancelled: 'keys.passkeys.problems.cancelled',
  exists: 'keys.passkeys.problems.exists',
  failed: 'keys.passkeys.problems.failed',
} as const satisfies Record<PasskeyProblem, string>

/** What to tell the person about a passkey that didn't work. */
export function passkeyProblemKey(e: unknown): (typeof PROBLEMS)[PasskeyProblem] {
  return PROBLEMS[e instanceof PasskeyError ? e.problem : problemOf(e)]
}
