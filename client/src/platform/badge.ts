// The Windows taskbar overlay: a red dot with the unread count, drawn here since the main process has no canvas.
const cache = new Map<string, string | null>()

export function overlayIcon(count: number): string | null {
  if (count <= 0 || typeof document === 'undefined') return null
  const text = count > 9 ? '9+' : String(count)
  if (cache.has(text)) return cache.get(text)!
  let url: string | null = null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#e5484d'
      ctx.beginPath()
      ctx.arc(16, 16, 16, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${text.length > 1 ? 17 : 21}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 16, 17)
      url = canvas.toDataURL('image/png')
    }
  } catch {
    url = null
  }
  cache.set(text, url)
  return url
}
