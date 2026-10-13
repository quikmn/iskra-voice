/**
 * Applies progress or a result to the pending upload it belongs to. Each attempt has its own AbortController, so an
 * attempt that was replaced (marking a file as a spoiler uploads it again under a new name) can't land on its
 * successor: an upload that had just finished used to mark the new one done with the old name, and the spoiler was lost.
 */
export function patchUpload<T extends { abort: AbortController }>(list: T[], attempt: AbortController, patch: Partial<T>): T[] {
  return list.map((u) => (u.abort === attempt ? { ...u, ...patch } : u))
}
