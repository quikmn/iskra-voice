import type { Messages } from '../types'

export const dmRequests: Messages['dmRequests'] = {
  title: 'Nachrichtenanfragen',
  badge_one: '{{count}} Nachrichtenanfrage',
  badge_other: '{{count}} Nachrichtenanfragen',
  empty: 'Keine neuen Anfragen.',
  ignoredCount_one: 'Ignoriert ({{count}})',
  ignoredCount_other: 'Ignoriert ({{count}})',
  bar: '{{name}} möchte dir schreiben.',
  ignoredBar: 'Du hast die Anfrage von {{name}} ignoriert.',
  barHint: 'Die Person erfährt nicht, ob du sie gesehen hast. Links und Dateien bleiben verborgen, bis du annimmst.',
  accept: 'Annehmen',
  ignore: 'Ignorieren',
  block: 'Blockieren',
  filesHidden_one: '{{count}} Datei, verborgen, bis du annimmst',
  filesHidden_other: '{{count}} Dateien, verborgen, bis du annimmst',
  settingTitle: 'Wer mir schreiben darf',
  refused: '{{server}} hat diese Wahl nicht übernommen und behält die vorherige: {{reason}}',
  settingHint: 'Gilt auf allen deinen Servern. Leute, mit denen du schon geschrieben hast, können dir immer schreiben, und du kannst weiterhin mit allen eine Unterhaltung starten.',
  who: {
    anyone: 'Alle auf meinen Servern',
    requests: 'Alle, als Nachrichtenanfrage',
    known: 'Leute, mit denen ich geschrieben habe, und das Serverteam',
    nobody: 'Nur Leute, mit denen ich geschrieben habe',
  },
  whoHint: {
    anyone: 'Neue Nachrichten landen direkt in deinen Direktnachrichten.',
    requests: 'Neue Leute landen ohne Benachrichtigung in den Nachrichtenanfragen, bis du annimmst. Moderatoren und Admins kommen direkt durch.',
    known: 'Andere können keine Unterhaltung mit dir starten. Moderatoren und Admins schon.',
    nobody: 'Niemand Neues kann eine Unterhaltung mit dir starten, auch das Serverteam nicht.',
  },
}
