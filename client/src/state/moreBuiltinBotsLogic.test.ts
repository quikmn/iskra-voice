import { describe, expect, it } from 'vitest'
import type { BirthdayConfig, StarboardConfig, WelcomeConfig } from '../core/protocol'
import { localizeCommand } from './builtinBotsLogic'
import {
  birthdayLabel, configPatch, configProblem, daysIn, fillTemplate, isMoreBuiltin, monthNames, nameList, timeZones, validTime,
} from './moreBuiltinBotsLogic'

const t = (key: string) => key

describe('Starboard, Birthdays and Welcome settings', () => {
  it('knows which built-in bots have settings', () => {
    expect(['starboard', 'birthdays', 'welcome'].every(isMoreBuiltin)).toBe(true)
    expect(isMoreBuiltin('dice')).toBe(false)
  })

  it('previews a welcome like the server fills it', () => {
    expect(fillTemplate('Hi {name}, welcome to **{server}**! You are #{memberCount}. {name}!', 'Anna', 'Pizza Club', 12))
      .toBe('Hi Anna, welcome to **Pizza Club**! You are #12. Anna!')
    expect(fillTemplate('{unknown} stays', 'A', 'B', 1)).toBe('{unknown} stays')
  })

  it('sends only what changed', () => {
    const saved: StarboardConfig = { channelId: 3, emoji: '⭐', threshold: 3 }
    expect(configPatch(saved, { ...saved })).toEqual({})
    expect(configPatch(saved, { ...saved, threshold: 5, channelId: null })).toEqual({ threshold: 5, channelId: null })
    const zone: BirthdayConfig = { channelId: 1, time: '09:00', timeZone: null, serverTimeZone: 'UTC' }
    expect(configPatch(zone, { ...zone, serverTimeZone: 'Europe/Stockholm', timeZone: 'Europe/Stockholm' })).toEqual({ timeZone: 'Europe/Stockholm' })
  })

  it('says what is wrong before saving', () => {
    expect(configProblem('starboard', { channelId: 1, emoji: '⭐', threshold: 0 })).toBe('threshold')
    expect(configProblem('starboard', { channelId: 1, emoji: '⭐', threshold: 51 })).toBe('threshold')
    expect(configProblem('starboard', { channelId: 1, emoji: '⭐', threshold: NaN })).toBe('threshold')
    expect(configProblem('starboard', { channelId: 1, emoji: ' ', threshold: 3 })).toBe('emoji')
    expect(configProblem('starboard', { channelId: null, emoji: '🔥', threshold: 50 })).toBeNull()
    expect(configProblem('birthdays', { channelId: 1, time: '9:00', timeZone: null, serverTimeZone: 'UTC' })).toBe('time')
    expect(configProblem('birthdays', { channelId: 1, time: '23:59', timeZone: null, serverTimeZone: 'UTC' })).toBeNull()
    const welcome: WelcomeConfig = { channelId: 1, message: 'a'.repeat(1001), privateMessage: '' }
    expect(configProblem('welcome', welcome)).toBe('template')
    expect(configProblem('welcome', { ...welcome, message: '' })).toBeNull()
  })

  it('checks times like the server', () => {
    expect(['00:00', '09:30', '23:59'].every(validTime)).toBe(true)
    expect(['24:00', '9:30', '09:60', '', '09:00:00'].some(validTime)).toBe(false)
  })
})

describe('birthdays', () => {
  it('has a day for every date, 29 February included', () => {
    expect(daysIn(2)).toBe(29)
    expect(daysIn(4)).toBe(30)
    expect(daysIn(12)).toBe(31)
  })

  it('words dates and names without a year', () => {
    expect(birthdayLabel(3, 14, 'en')).toBe('March 14')
    expect(birthdayLabel(3, 14, 'sv')).toBe('14 mars')
    expect(monthNames('en')[0]).toBe('January')
    expect(monthNames('sv')).toHaveLength(12)
    expect(nameList(['Anna', 'Bob', 'Cleo'], 'en')).toBe('Anna, Bob, and Cleo')
    expect(nameList(['Anna', 'Bob'], 'sv')).toBe('Anna och Bob')
  })

  it('offers time zones, with the saved one even if the browser lacks it', () => {
    const zones = timeZones('Mars/Olympus')
    expect(zones[0]).toBe('Mars/Olympus')
    expect(timeZones(null).includes('Mars/Olympus')).toBe(false)
  })

  it('words /birthday in the app language', () => {
    expect(localizeCommand({ name: 'birthday', description: 'Birthday greetings', usage: 'set 14 March' }, t))
      .toEqual({ name: 'birthday', description: 'builtinBots.commands.birthday.description', usage: 'builtinBots.commands.birthday.usage' })
  })
})
