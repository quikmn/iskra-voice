import type { Messages } from '../types'

export const share: Messages['share'] = {
  title: 'Dela till…',
  preview: 'Det här delar du',
  message: 'Meddelande',
  messagePlaceholder: 'Lägg till ett meddelande (valfritt)',
  skipped_one: '{{count}} fil kunde inte läggas till (för stor, eller fler än 10).',
  skipped_other: '{{count}} filer kunde inte läggas till (för stora, eller fler än 10).',
  sendToLabel: 'Skicka till',
  search: 'Sök kanaler, personer och grupper',
  places: 'Ställen att dela till',
  recent: 'Senaste',
  everywhere: 'Överallt',
  nothing: 'Inget matchar.',
  loading: 'Ansluter till dina servrar…',
  noServers: 'Gå med i en server först, sedan kan du dela hit.',
  dm: 'Direktmeddelande',
  group: 'Grupp · {{server}}',
  sendTo: 'Skicka till {{target}}',
  sending: 'Skickar… {{percent}}',
  errors: {
    empty: 'Det finns inget att skicka.',
    offline: 'Den servern är inte ansluten just nu. Försök igen om en stund.',
    tooBig: '{{name}} är större än servern tillåter ({{max}}).',
    fileGone: '{{name}} finns inte kvar. Dela den igen.',
  },
}
