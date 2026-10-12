// Role colours as text: adjusted per theme so names read at 4.5:1 (the stored colour stays as the admin chose it).
import { useSyncExternalStore } from 'react'
import { getNameSurfaces, onNameSurfaces, readableColor } from './theme'

/** The colour as readable text on the current theme, or null for none. */
export function useReadableColor(color: string | null | undefined): string | null {
  const surfaces = useSyncExternalStore(onNameSurfaces, getNameSurfaces, getNameSurfaces)
  return color ? readableColor(color, surfaces) : null
}
