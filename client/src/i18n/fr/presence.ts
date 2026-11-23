import type { Messages } from '../types'

export const presence: Messages['presence'] = {
  status: {
    online: 'En ligne',
    idle: 'Inactif',
    dnd: 'Ne pas déranger',
    invisible: 'Invisible',
    offline: 'Hors ligne',
  },
  hints: {
    idle: 'Aussi défini automatiquement quand tu t’absentes',
    dnd: 'Ni sons, ni notifications, ni notifications push',
    invisible: 'Tu apparais hors ligne, mais tu peux utiliser Iskra comme d’habitude',
  },
  clearAfter: {
    '30m': '30 minutes',
    '1h': '1 heure',
    '4h': '4 heures',
    today: 'Aujourd’hui',
    never: 'Ne pas effacer',
  },
  clearsInMinutes: 'S’efface dans {{minutes}} min',
  clearsInHours: 'S’efface dans {{hours}} h',
  setStatus: 'Définir ton statut (actuellement {{status}})',
  yourStatus: 'Ton statut',
  setCustom: 'Définir un statut personnalisé',
  clearCustom: 'Effacer le statut personnalisé',
  custom: {
    title: 'Statut personnalisé',
    clear: 'Effacer le statut',
    hint: 'Affiché à côté de ton nom sur tous tes serveurs.',
    label: 'Quoi de neuf ?',
    changeEmoji: 'Émoji {{emoji}}, changer',
    pickEmoji: 'Choisir un émoji',
    placeholder: 'ex. : Pause déjeuner',
    clearInput: 'Effacer le texte et l’émoji',
    clearAfter: 'Effacer après',
  },
  errors: {
    singleEmoji: 'Choisis un seul émoji.',
    tooLong: 'Un statut personnalisé peut faire jusqu’à {{max}} caractères.',
  },
  activity: {
    playing: 'Joue à <b>{{name}}</b>',
    playingTitle: 'Joue à {{name}}',
    justStarted: 'vient de commencer',
    minutes: '{{minutes}} min',
    hours: '{{hours}} h',
    hoursMinutes: '{{hours}} h {{minutes}} min',
  },
}
