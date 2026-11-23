import type { Messages } from '../types'

export const afk: Messages['afk'] = {
  forced: 'Canale AFK: microfono e audio disattivati',
  forcedHint: 'Nel canale AFK il server ti disattiva il microfono e non puoi sentire nessuno. Entra in un altro canale vocale per tornare a parlare.',
  badge: 'AFK',
  channelHint: 'Canale AFK',
  participantForced: 'Microfono e audio disattivati (canale AFK)',
  movedTitle: 'Spostamento in {{channel}}',
  movedBody: 'Non c\'è stata attività da parte tua in vocale per {{minutes}} minuti, quindi {{server}} ti ha spostato nel suo canale AFK. Entra in un canale vocale qualsiasi per tornare.',
  movedBodyShort: 'Non c\'è stata attività da parte tua in vocale, quindi {{server}} ti ha spostato nel suo canale AFK. Entra in un canale vocale qualsiasi per tornare.',
  settings: {
    intro: "Dai un posto a chi si allontana. Chi resta inattivo per un po' in un canale vocale viene spostato nel canale AFK, dove microfono e audio sono disattivati.",
    channel: 'Canale AFK',
    none: 'Nessun canale AFK',
    create: 'Crea canale AFK',
    defaultName: 'AFK',
    idle: 'Sposta chi è inattivo dopo',
    minutes: '{{n}} minuti',
    never: 'Mai',
    idleHint: "Inattivo significa senza scrivere, fare clic o toccare (ovunque sul computer nell'app desktop, in Iskra sul web e sui telefoni) e senza parlare, per tutto il tempo. Chi sta parlando non viene mai spostato.",
    canTalk: 'Possono parlare qui',
    canTalkHint: 'A tutti gli altri nel canale AFK il server disattiva microfono e audio, qualunque siano le loro impostazioni.',
    baseRoles: 'Ruoli integrati',
    customRoles: 'Ruoli',
    saved: 'Salvato',
  },
}
