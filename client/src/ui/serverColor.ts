// A server's own colour, for the server room's band and its active-nav marker (and the menu's tile).
// There's no owner-set colour yet (that would be a protocol change); this one is derived from the server key.

/**
 * A stable hue (0–359) for a server key: 32-bit FNV-1a over the key's characters, modulo 360. The same key gives
 * the same hue on every device and every run, and keys that differ by one character land far apart.
 */
export function serverHue(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 360
}

/**
 * The colours drawn from that hue. `band` is dark enough for white text on both themes; `marker` is brighter, for a
 * thin bar beside the active nav item; `tile` is the server's initials tile on the band.
 */
export function serverColor(key: string): { hue: number; band: string; marker: string; tile: string } {
  const hue = serverHue(key)
  return {
    hue,
    band: `hsl(${hue} 52% 34%)`,
    marker: `hsl(${hue} 70% 56%)`,
    tile: `hsl(${hue} 60% 22%)`,
  }
}
