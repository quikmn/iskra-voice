import type { Messages } from '../types'

export const dmRequests: Messages['dmRequests'] = {
  title: 'Meddelandeförfrågningar',
  badge_one: '{{count}} meddelandeförfrågan',
  badge_other: '{{count}} meddelandeförfrågningar',
  empty: 'Inga nya förfrågningar.',
  ignoredCount_one: 'Ignorerade ({{count}})',
  ignoredCount_other: 'Ignorerade ({{count}})',
  bar: '{{name}} vill skicka meddelanden till dig.',
  ignoredBar: 'Du ignorerade förfrågan från {{name}}.',
  barHint: 'Hen vet inte om du har sett den. Länkar och filer visas först när du godkänner.',
  accept: 'Godkänn',
  ignore: 'Ignorera',
  block: 'Blockera',
  filesHidden_one: '{{count}} fil, dold tills du godkänner',
  filesHidden_other: '{{count}} filer, dolda tills du godkänner',
  settingTitle: 'Vem kan skriva till mig',
  refused: '{{server}} tog inte emot valet och behåller det förra: {{reason}}',
  settingHint: 'Gäller på alla servrar du är med i. Personer du redan har pratat med kan alltid skriva till dig, och du kan fortfarande själv starta en konversation med vem som helst.',
  who: {
    anyone: 'Alla på mina servrar',
    requests: 'Alla, som meddelandeförfrågan',
    known: 'Personer jag har pratat med, och serverns personal',
    nobody: 'Bara personer jag har pratat med',
  },
  whoHint: {
    anyone: 'Nya meddelanden hamnar direkt bland dina direktmeddelanden.',
    requests: 'Nya personer hamnar i Meddelandeförfrågningar, utan aviseringar, tills du godkänner. Moderatorer och admins kommer direkt fram.',
    known: 'Andra kan inte starta en konversation med dig. Moderatorer och admins kan.',
    nobody: 'Ingen ny kan starta en konversation med dig, inte heller personalen.',
  },
}
