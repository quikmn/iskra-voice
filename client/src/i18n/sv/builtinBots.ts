import type { Messages } from '../types'

export const builtinBots: Messages['builtinBots'] = {
  badge: 'INBYGGD',
  badgeTitle: 'Körs av den här servern: inget att installera',
  names: {
    // The bots' names (as they show in chat), the same in every language.
    dice: 'Dice',
    polls: 'Polls',
    reminders: 'Reminders',
  },
  about: {
    dice: 'Slår tärningar till spel: /roll 2d6+3',
    polls: 'Startar en omröstning: /poll Pizza eller tacos? | Pizza | Tacos',
    reminders: 'Påminner dig senare: /remind mig om 10m ta ut pizzan',
  },
  commands: {
    roll: { description: 'Slå tärningar, till exempel 2d6+3', usage: '2d6+3' },
    poll: { description: 'Starta en omröstning', usage: 'Fråga | Svar | Svar' },
    remind: { description: 'Få en påminnelse senare', usage: 'mig om 10m vad' },
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
