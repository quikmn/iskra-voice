import type { Messages } from '../types'

export const afk: Messages['afk'] = {
  forced: 'AFK-kanal: mikrofon och ljud avstängda',
  forcedHint: 'I AFK-kanalen stänger servern av din mikrofon och du hör ingen. Gå med i en annan röstkanal för att prata igen.',
  badge: 'AFK',
  channelHint: 'AFK-kanal',
  participantForced: 'Mikrofon och ljud avstängda (AFK-kanal)',
  movedTitle: 'Flyttad till {{channel}}',
  movedBody: 'Du var inaktiv i röstkanalen i {{minutes}} minuter, så {{server}} flyttade dig till sin AFK-kanal. Gå med i valfri röstkanal för att komma tillbaka.',
  movedBodyShort: 'Du var inaktiv i röstkanalen, så {{server}} flyttade dig till sin AFK-kanal. Gå med i valfri röstkanal för att komma tillbaka.',
  settings: {
    intro: 'Ge den som går ifrån en plats att vara på. Den som är inaktiv i en röstkanal ett tag flyttas till AFK-kanalen, där mikrofon och ljud är avstängda.',
    channel: 'AFK-kanal',
    none: 'Ingen AFK-kanal',
    create: 'Skapa AFK-kanal',
    defaultName: 'AFK',
    idle: 'Flytta inaktiva efter',
    minutes: '{{n}} minuter',
    never: 'Aldrig',
    idleHint: 'Inaktiv betyder att du inte skriver, klickar eller trycker (någonstans på datorn i skrivbordsappen, i Iskra på webben och i mobilen) och inte pratar, under hela tiden. Den som pratar flyttas aldrig.',
    canTalk: 'Kan prata här',
    canTalkHint: 'Alla andra i AFK-kanalen får mikrofon och ljud avstängda av servern, oavsett sina egna inställningar.',
    baseRoles: 'Grundroller',
    customRoles: 'Roller',
    saved: 'Sparat',
  },
}
