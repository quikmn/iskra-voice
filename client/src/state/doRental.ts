// Rent a server on DigitalOcean (desktop app): picking a region, prices, error texts and the "Your server" document.
// The token and every API call live in the desktop app's main process (desktop/src/digitalocean.ts); this side
// makes the setup text (rentServer.ts) and claims the server once it answers.
import { intlLocale, t } from '../i18n'
import { LINKS, RELEASE_VERSION } from '../links'
import type { DigitalOceanError, DoRegionChoice } from '../platform/desktop'

/** DigitalOcean regions by time zone, nearest first. A guess the user can change. */
const BY_ZONE: [RegExp, string[]][] = [
  [/^(Europe\/(London|Dublin|Lisbon)|Atlantic\/(Reykjavik|Faroe|Canary|Madeira))$/, ['lon1', 'ams3', 'fra1']],
  [/^Europe\/(Amsterdam|Brussels|Paris|Luxembourg|Madrid|Andorra|Monaco|Gibraltar)$/, ['ams3', 'lon1', 'fra1']],
  [/^Europe\//, ['fra1', 'ams3', 'lon1']],
  [/^Africa\//, ['fra1', 'ams3', 'lon1']],
  [/^America\/(Toronto|Montreal|Halifax|St_Johns|Moncton|Winnipeg|Regina|Nipigon|Thunder_Bay)$/, ['tor1', 'nyc3', 'nyc1']],
  [/^(America\/(Los_Angeles|Vancouver|Tijuana|Phoenix|Denver|Boise|Edmonton|Whitehorse|Dawson|Anchorage|Juneau|Sitka|Nome|Hermosillo)|Pacific\/Honolulu)$/, ['sfo3', 'sfo2', 'sfo1']],
  [/^America\/(Chicago|Mexico_City|Monterrey|Merida|Matamoros|Indiana\/.+|Kentucky\/.+)$/, ['atl1', 'nyc3', 'nyc1']],
  [/^(America|Atlantic)\//, ['nyc3', 'nyc1', 'atl1', 'tor1']],
  [/^Asia\/(Kolkata|Calcutta|Colombo|Dhaka|Karachi|Kathmandu|Thimphu|Dubai|Muscat|Riyadh|Qatar|Bahrain|Kuwait)$/, ['blr1', 'sgp1']],
  [/^Asia\/(Jerusalem|Tel_Aviv|Beirut|Amman|Damascus|Baghdad|Tehran|Istanbul|Nicosia|Tbilisi|Yerevan|Baku)$/, ['fra1', 'ams3', 'blr1']],
  [/^(Australia|Pacific\/(Auckland|Chatham|Fiji))\b/, ['syd1', 'sgp1']],
  [/^(Asia|Indian|Pacific)\//, ['sgp1', 'syd1', 'blr1']],
]

/** The region nearest the user's time zone, if DigitalOcean offers it; else New York, else the first one. */
export function guessRegion(timeZone: string, regions: readonly Pick<DoRegionChoice, 'slug'>[]): string | null {
  const offered = new Set(regions.map((r) => r.slug))
  const preferred = BY_ZONE.find(([zone]) => zone.test(timeZone))?.[1] ?? ['nyc3', 'nyc1', 'ams3']
  return [...preferred, 'nyc3', 'ams3'].find((slug) => offered.has(slug)) ?? regions[0]?.slug ?? null
}

export function userTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    return ''
  }
}

/** DigitalOcean bills in US dollars. */
export function formatPrice(usd: number): string {
  const whole = Number.isInteger(usd)
  return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(usd)
}

export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`
}

/** An error from the desktop app, in words. `detail` is DigitalOcean's own (English) text. */
export function errorText(error: DigitalOceanError | 'unavailable', detail = ''): { text: string; detail: string | null } {
  const key = error === 'timeout' ? (detail === 'boot' ? 'timeoutBoot' : 'timeoutInstall') : error
  const own = detail && error !== 'timeout' ? t('rental.failed.detail', { detail }) : null
  return { text: t(`rental.errors.${key}`), detail: own }
}

export interface RentedServer {
  name: string
  url: string
  ip: string
  dropletName: string
  region: string
  regionName: string
  size: DoRegionChoice['size']
  ssh: boolean
  version?: string
  createdAt?: Date
}

/** The ready-to-copy prompt for an AI assistant. Only facts about the setup: no keys, no token. */
export function aiHelpPrompt(s: RentedServer): string {
  const version = s.version ?? RELEASE_VERSION
  return t('rental.doc.ai', {
    droplet: s.dropletName,
    region: s.region,
    size: s.size.slug,
    ip: s.ip,
    url: s.url,
    version,
    ssh: t(s.ssh ? 'rental.doc.sshOpen' : 'rental.doc.sshClosed'),
  })
}

/** "Your server": everything the owner needs later, as Markdown (reads fine as plain text too). No secrets. */
export function serverDocument(s: RentedServer): string {
  const date = new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'long' }).format(s.createdAt ?? new Date())
  const price = formatPrice(s.size.priceMonthly)
  const size = `${s.size.slug}, ${formatMemory(s.size.memoryMb)}`
  const section = (title: string, body: string) => `## ${title}\n\n${body}\n`
  return [
    `# ${t('rental.doc.title', { name: s.name })}\n`,
    `${t('rental.doc.made', { date })}\n`,
    section(t('rental.doc.addressTitle'), t('rental.doc.address', { url: s.url, ip: s.ip, droplet: s.dropletName, region: s.regionName, size })),
    section(t('rental.doc.joinTitle'), t('rental.doc.join')),
    section(t('rental.doc.keysTitle'), t('rental.doc.keys')),
    section(t('rental.doc.costTitle'), t('rental.doc.cost', { price, billing: LINKS.digitalOceanBilling, droplets: LINKS.digitalOceanDroplets, droplet: s.dropletName })),
    section(t('rental.doc.updatesTitle'), t('rental.doc.updates')),
    section(t('rental.doc.moveTitle'), t('rental.doc.move', { guide: `${LINKS.hostingReference}#moving-a-server-to-another-computer` })),
    section(t('rental.doc.seesTitle'), t('rental.doc.sees')),
    section(t('rental.doc.aiTitle'), `${t('rental.doc.aiIntro')}\n\n\`\`\`text\n${aiHelpPrompt(s)}\n\`\`\``),
  ].join('\n')
}

/** A file name that works on every OS. */
export function documentFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Iskra'
  return t('rental.doc.fileName', { name: safe })
}
