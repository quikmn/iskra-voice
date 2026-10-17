// Every assistant tool, in the order models and MCP clients see them.
import { READ_TOOLS } from './read'
import { ORGANIZE_TOOLS } from './organize'
import { ADMIN_TOOLS, MODERATION_TOOLS } from './moderation'
import type { ToolDef } from './registry'

export const ALL_TOOLS: readonly ToolDef[] = [...READ_TOOLS, ...ORGANIZE_TOOLS, ...MODERATION_TOOLS, ...ADMIN_TOOLS]
