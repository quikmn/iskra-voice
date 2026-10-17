import type { Messages } from '../types'

export const builtinBots: Messages['builtinBots'] = {
  badge: 'INBYGGD',
  badgeTitle: 'Körs av den här servern: inget att installera',
  names: {
    // The bots' names (as they show in chat), the same in every language.
    dice: 'Dice',
    polls: 'Polls',
    reminders: 'Reminders',
    starboard: 'Starboard',
    birthdays: 'Birthdays',
    welcome: 'Welcome',
    feeds: 'Feeds',
  },
  about: {
    dice: 'Slår tärningar till spel: /roll 2d6+3',
    polls: 'Startar en omröstning: /poll Pizza eller tacos? | Pizza | Tacos',
    reminders: 'Påminner dig senare: /remind mig om 10m ta ut pizzan',
    starboard: 'Visar de mest stjärnmärkta meddelandena i en kanal',
    birthdays: 'Gratulerar medlemmar på födelsedagen: /birthday sätt 14 mars',
    welcome: 'Hälsar nya medlemmar välkomna',
    feeds: 'Lägger upp nya blogginlägg, YouTube-videor och Twitch-sändningar',
  },
  commands: {
    roll: { description: 'Slå tärningar, till exempel 2d6+3', usage: '2d6+3' },
    poll: { description: 'Starta en omröstning', usage: 'Fråga | Svar | Svar' },
    remind: { description: 'Få en påminnelse senare', usage: 'mig om 10m vad' },
    birthday: { description: 'Dela din födelsedag, eller se vems som är på väg', usage: 'sätt 14 mars | ta bort | lista' },
  },
  settings: {
    title: 'Inbyggda bottar',
    intro: 'De här körs i din server, så det finns inget att installera. Slå på en så kan alla använda dess kommando i kanalerna den ser. De kan inte läsa krypterade kanaler.',
    toggle: 'Slå på {{name}}',
    on: 'På',
    off: 'Av',
  },
  reply: {
    roll: '🎲 {{name}} slog {{expression}}',
    rollInvalid: '🎲 {{name}}, "{{input}}" är inte tärningsnotation. Testa /roll 2d6+3 eller /roll d20.',
    pollUsage: '📊 {{name}}, starta en omröstning så här: /poll Pizza eller tacos? | Pizza | Tacos',
    remind: '⏰ Okej {{name}}, jag påminner dig: {{when}}.',
    remindUsage: '⏰ {{name}}, lägg till en påminnelse så här: /remind mig om 10m ta ut pizzan (från 1 minut upp till ett år).',
    error: '{{name}}: {{message}}',
    total: 'Summa',
  },
  encryptedHint: 'Bottar kan inte läsa krypterade kanaler, så /kommandon fungerar inte här.',
}
