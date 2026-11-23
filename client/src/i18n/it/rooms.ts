import type { Messages } from '../types'

export const rooms: Messages['rooms'] = {
  lobby: {
    join: 'Entra in {{name}} per avere una stanza tutta tua',
    badge: 'Lobby',
    badgeHint: 'Entrando si crea una stanza vocale tutta tua, subito sotto questo canale.',
  },
  room: {
    locked: 'Chiusa',
    lockedHint: "{{name}} è chiusa: può entrare solo chi viene invitato dall'host.",
    host: 'Host',
    hostOf: "{{name}} è l'host di questa stanza",
    yours: 'La tua stanza',
  },
  settings: {
    title: 'Impostazioni della stanza',
    menu: 'Impostazioni della stanza…',
    button: 'La tua stanza',
    name: 'Nome',
    nameHint: 'Compare come {{slug}}.',
    locked: 'Chiudi la stanza',
    lockedHint: 'Mentre è chiusa possono entrare solo tu, le persone che inviti e i moderatori. Chi è già dentro non viene rimosso.',
    invite: 'Chi può entrare mentre è chiusa',
    invited: 'Invitati',
    search: 'Cerca membri',
    nobodyMatches: 'Nessun risultato.',
    add: 'Invita',
    remove: "Revoca l'invito",
    emptiesHint: "La stanza viene rimossa circa 30 secondi dopo che l'ultima persona è uscita.",
  },
  userMenu: {
    invite: 'Invita in {{room}}',
    uninvite: "Revoca l'invito a {{room}}",
  },
}
