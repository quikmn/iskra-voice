// When the "Pick your roles" screen is worth showing (pure; tested in rolePickerLogic.test.ts).
import type { RoleGroup, ServerRole } from '../core/protocol'

/** Groups with at least one role left to pick (an empty group has nothing to ask). */
export const askableGroups = (groups: RoleGroup[], roles: ServerRole[]): RoleGroup[] =>
  groups.filter((g) => g.roles.some((id) => roles.some((r) => r.id === id && r.selfAssign)))

/**
 * Right after joining from an invite, open the picker by itself when the server asks something and there's no rules
 * screen first (with required rules, the rules screen shows the picker after agreeing). Never on a reconnect.
 */
export function shouldOpenPickerAfterJoin(firstJoin: boolean, groups: RoleGroup[], roles: ServerRole[], mustAgree: boolean): boolean {
  return firstJoin && !mustAgree && askableGroups(groups, roles).length > 0
}
