import { describe, expect, it } from 'vitest'
import { i18next } from '../i18n'
import { LINKS } from '../links'
import { aiHelpPrompt, documentFileName, errorText, formatPrice, guessRegion, serverDocument, type RentedServer } from './doRental'

const REGIONS = ['ams3', 'blr1', 'fra1', 'lon1', 'nyc1', 'nyc3', 'sfo3', 'sgp1', 'syd1', 'tor1', 'atl1'].map((slug) => ({ slug }))

const SERVER: RentedServer = {
  name: 'Game Night',
  url: 'https://203-0-113-7.sslip.io',
  ip: '203.0.113.7',
  dropletName: 'iskra-game-night',
  region: 'fra1',
  regionName: 'Frankfurt 1',
  size: { slug: 's-1vcpu-1gb', memoryMb: 1024, vcpus: 1, diskGb: 25, priceMonthly: 6 },
  ssh: false,
  version: '2.0.0-alpha.14',
  createdAt: new Date('2026-10-14T12:00:00Z'),
}

describe('DigitalOcean rental', () => {
  it('guesses the nearest region from the time zone', () => {
    expect(guessRegion('Europe/Stockholm', REGIONS)).toBe('fra1')
    expect(guessRegion('Europe/London', REGIONS)).toBe('lon1')
    expect(guessRegion('Europe/Paris', REGIONS)).toBe('ams3')
    expect(guessRegion('America/Los_Angeles', REGIONS)).toBe('sfo3')
    expect(guessRegion('America/Toronto', REGIONS)).toBe('tor1')
    expect(guessRegion('America/New_York', REGIONS)).toBe('nyc3')
    expect(guessRegion('America/Chicago', REGIONS)).toBe('atl1')
    expect(guessRegion('Asia/Kolkata', REGIONS)).toBe('blr1')
    expect(guessRegion('Asia/Tokyo', REGIONS)).toBe('sgp1')
    expect(guessRegion('Australia/Sydney', REGIONS)).toBe('syd1')
    expect(guessRegion('', REGIONS)).toBe('nyc3')
    // Only regions DigitalOcean offers right now.
    expect(guessRegion('Europe/Stockholm', [{ slug: 'lon1' }, { slug: 'sgp1' }])).toBe('lon1')
    expect(guessRegion('Asia/Tokyo', [{ slug: 'tor1' }])).toBe('tor1')
    expect(guessRegion('Asia/Tokyo', [])).toBeNull()
  })

  it('shows prices in dollars, in the language', async () => {
    expect(formatPrice(6)).toBe('$6')
    expect(formatPrice(4.5)).toBe('$4.50')
    await i18next.changeLanguage('sv')
    try {
      expect(formatPrice(6)).toMatch(/^6\s?US\$$/)
    } finally {
      await i18next.changeLanguage('en')
    }
  })

  it('turns error codes into words, with what DigitalOcean said', () => {
    expect(errorText('scope', 'You are not authorized').text).toContain('missing a permission')
    expect(errorText('scope', 'You are not authorized').detail).toBe('DigitalOcean said: You are not authorized')
    expect(errorText('timeout', 'boot').text).toContain('5 minutes')
    expect(errorText('timeout', 'install').text).toContain('25 minutes')
    expect(errorText('timeout', 'install').detail).toBeNull()
    expect(errorText('denied').text).toContain('API token')
    expect(errorText('network').detail).toBeNull()
  })

  it('writes the server document: every part, the facts, and no secrets', () => {
    const doc = serverDocument(SERVER)
    expect(doc.startsWith('# Game Night: your Iskra server\n')).toBe(true)
    for (const heading of ['Address', 'How friends join', 'Your keys and recovery', 'What it costs, and how to cancel', 'Updates and backups', 'Moving it later', 'What Iskra can and can’t see', 'Help from an AI assistant']) {
      expect(doc).toContain(`\n## ${heading}\n`)
    }
    expect(doc).toContain('https://203-0-113-7.sslip.io')
    expect(doc).toContain('"iskra-game-night" in Frankfurt 1 (s-1vcpu-1gb, 1 GB)')
    expect(doc).toContain('$6 a month')
    expect(doc).toContain('Destroy → Destroy this Droplet')
    expect(doc).toContain(LINKS.digitalOceanDroplets)
    expect(doc).toContain('October 14, 2026')
    expect(doc).toContain('```text\nI run an Iskra server')
    expect(doc).not.toMatch(/dop_v1|doo_v1|OwnerClaim|owner-claim|password:/i)
  })

  it('gives an AI assistant the exact setup', () => {
    const prompt = aiHelpPrompt(SERVER)
    for (const fact of ['Ubuntu 24.04 LTS', '/opt/iskra/world', 'systemd service "iskra"', 'journalctl -u iskra', '7882/udp', 'iskra-server-2.0.0-alpha.14-linux-x64.tar.gz', '/var/log/iskra-setup.log', 'region fra1', '203.0.113.7']) {
      expect(prompt).toContain(fact)
    }
    expect(prompt).toContain('SSH (22/tcp) is not allowed')
    expect(aiHelpPrompt({ ...SERVER, ssh: true })).toContain('SSH (22/tcp) is allowed')
  })

  it('in Swedish too', async () => {
    await i18next.changeLanguage('sv')
    try {
      const doc = serverDocument(SERVER)
      expect(doc.startsWith('# Game Night: din Iskra-server\n')).toBe(true)
      expect(doc).toContain('## Vad det kostar och hur du säger upp')
      expect(documentFileName('Game Night')).toBe('Iskra-server - Game Night.md')
    } finally {
      await i18next.changeLanguage('en')
    }
  })

  it('names the file safely', () => {
    expect(documentFileName('Game Night')).toBe('Iskra server - Game Night.md')
    expect(documentFileName('a/b\\c:d*?"<>|')).toBe('Iskra server - a b c d.md')
    expect(documentFileName('   ')).toBe('Iskra server - Iskra.md')
  })
})
