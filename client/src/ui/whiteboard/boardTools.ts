// The whiteboard's tools, colours and sizes, and what the floating toolbar shows for them (no DOM here).
export type Tool = 'select' | 'pan' | 'pen' | 'hl' | 'eraser' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'note'
export type ShapeTool = 'line' | 'arrow' | 'rect' | 'ellipse'

export const COLORS = ['#1f2328', '#e5484d', '#f76b15', '#f5d90a', '#30a46c', '#0090ff', '#8e4ec6', '#ffffff'] as const
export const COLOR_NAMES = ['black', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'white'] as const
export const SIZES: Record<'stroke' | 'hl' | 'text', [number, number, number]> = { stroke: [2, 4, 8], hl: [12, 20, 32], text: [18, 28, 44] }

/** The shapes share one button in the toolbar (it opens the four of them). */
export const SHAPES: readonly ShapeTool[] = ['line', 'arrow', 'rect', 'ellipse']
export const isShape = (tool: Tool): tool is ShapeTool => (SHAPES as readonly Tool[]).includes(tool)

/** The tools in the toolbar's row, in order: the shapes button stands where the four shapes would. */
export const ROW_TOOLS: readonly (Exclude<Tool, ShapeTool> | 'shapes')[] = ['select', 'pan', 'pen', 'hl', 'eraser', 'shapes', 'text', 'note']

/** What the row shows for someone who may draw, or only look (select and move around). */
export const rowFor = (drawing: boolean): readonly (Exclude<Tool, ShapeTool> | 'shapes')[] =>
  drawing ? ROW_TOOLS : ROW_TOOLS.filter((x) => x === 'select' || x === 'pan')

/** Which set of sizes the size buttons pick from, for the tool in hand. */
export const sizeKind = (tool: Tool): 'stroke' | 'hl' | 'text' => (tool === 'hl' ? 'hl' : tool === 'text' || tool === 'note' ? 'text' : 'stroke')

/** The dot that stands for a size (px across), kept small enough for its button. */
export function sizeDot(kind: 'stroke' | 'hl' | 'text', index: number): number {
  return Math.min(18, 3 + (kind === 'stroke' ? SIZES.stroke[index] : index * 5 + 4))
}
