import type { Messages } from '../types'

export const shell: Messages['shell'] = {
  members: {
    title: 'Medlemmar',
    count_one: '{{count}} medlem',
    count_other: '{{count}} medlemmar',
    search: 'Sök medlemmar',
    searchPlaceholder: 'Hitta någon',
    clear: 'Rensa sökningen',
    close: 'Stäng medlemmar',
    none: 'Ingen här heter "{{query}}".',
  },
  recovery: {
    row: 'Spara din återställningsnyckel',
    notSaved: 'Återställningsnyckeln är inte sparad än',
  },
}
