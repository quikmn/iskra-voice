// When the join questions are worth showing (pure; tested in rolePickerLogic.test.ts). See joinQuestionsLogic.ts.
import type { RoleGroup, ServerRole } from '../core/protocol'
import { askableQuestions } from './joinQuestionsLogic'

/** Questions with at least one answer left to show (an empty one has nothing to ask). */
export const askableGroups = (groups: RoleGroup[], roles: ServerRole[]): RoleGroup[] => askableQuestions(groups, roles)
