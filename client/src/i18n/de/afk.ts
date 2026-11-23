import type { Messages } from '../types'

export const afk: Messages['afk'] = {
  forced: 'AFK-Kanal: stumm und Ton aus',
  forcedHint: 'Im AFK-Kanal schaltet der Server dich stumm und du hörst niemanden. Tritt einem anderen Sprachkanal bei, um wieder zu reden.',
  badge: 'AFK',
  channelHint: 'AFK-Kanal',
  participantForced: 'Stumm und Ton aus (AFK-Kanal)',
  movedTitle: 'Nach {{channel}} verschoben',
  movedBody: 'Du warst {{minutes}} Minuten im Sprachchat inaktiv, deshalb hat {{server}} dich in den AFK-Kanal verschoben. Tritt einem Sprachkanal bei, um zurückzukommen.',
  movedBodyShort: 'Du warst im Sprachchat inaktiv, deshalb hat {{server}} dich in den AFK-Kanal verschoben. Tritt einem Sprachkanal bei, um zurückzukommen.',
  settings: {
    intro: 'Gib allen, die kurz weg sind, einen Platz. Wer eine Weile in einem Sprachkanal inaktiv ist, wird in den AFK-Kanal verschoben und ist dort stumm und hört nichts.',
    channel: 'AFK-Kanal',
    none: 'Kein AFK-Kanal',
    create: 'AFK-Kanal erstellen',
    defaultName: 'AFK',
    idle: 'Inaktive verschieben nach',
    minutes: '{{n}} Minuten',
    never: 'Nie',
    idleHint: 'Inaktiv heißt: die ganze Zeit kein Tippen, Klicken oder Berühren (in der Desktop-App irgendwo am Computer, im Web und auf Handys in Iskra) und kein Sprechen. Wer redet, wird nie verschoben.',
    canTalk: 'Dürfen hier reden',
    canTalkHint: 'Alle anderen im AFK-Kanal schaltet der Server stumm und ohne Ton, egal was sie selbst eingestellt haben.',
    baseRoles: 'Feste Rollen',
    customRoles: 'Rollen',
    saved: 'Gespeichert',
  },
}
