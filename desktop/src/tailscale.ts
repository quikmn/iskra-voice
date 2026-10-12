// Tailscale, the recommended "gaming VPN" for hosts behind CGNAT: found from this computer's own network interfaces
// only. Nothing here asks Tailscale's API, its local daemon or anything on the network. (The server does the same in
// server/src/Iskra.Server/Hosting/Tailscale.cs.)

interface AddressInfo {
  address: string
  family: string | number
  internal: boolean
}

/** 100.64.0.0/10: the shared (carrier-grade NAT) range Tailscale gives its devices addresses from. */
export function inTailscaleRange(address: string): boolean {
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!m) return false
  const [b, c, d] = m.slice(1).map(Number)
  return b >= 64 && b <= 127 && c <= 255 && d <= 255
}

// The adapter is "Tailscale" on Windows and tailscale0 on Linux; macOS gives it a plain utunN.
const NAMED = /tailscale/i
const UTUN = /^utun\d+$/

/**
 * This computer's Tailscale address from os.networkInterfaces(): a 100.64.0.0/10 IPv4 address on Tailscale's adapter
 * (a provider's shared address on the real network card doesn't count). Null if Tailscale isn't on.
 */
export function tailscaleAddress(interfaces: Record<string, AddressInfo[] | undefined>): string | null {
  const found: { name: string; address: string }[] = []
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list ?? []) {
      const ipv4 = a.family === 'IPv4' || a.family === 4
      if (ipv4 && !a.internal && inTailscaleRange(a.address) && a.address !== '100.100.100.100') found.push({ name, address: a.address })
    }
  }
  return (found.find((f) => NAMED.test(f.name)) ?? found.find((f) => UTUN.test(f.name)))?.address ?? null
}

/** How friends on Tailscale reach a server on this computer, or null (no Tailscale, or a localhost-only server). */
export function tailscaleUrl(address: string | null, port: number, localOnly: boolean): string | null {
  return address && !localOnly ? `http://${address}:${port}` : null
}
