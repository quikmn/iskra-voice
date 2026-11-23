import type { Messages } from '../types'

export const disappear: Messages['disappear'] = {
  title: 'Messages éphémères',
  timers: {
    '0': 'Désactivé',
    '300': '5 minutes',
    '3600': '1 heure',
    '28800': '8 heures',
    '86400': '1 jour',
    '604800': '7 jours',
    '2419200': '4 semaines',
  },
  short: {
    '300': '5 min',
    '3600': '1 h',
    '28800': '8 h',
    '86400': '1 j',
    '604800': '7 j',
    '2419200': '4 sem.',
  },
  button: 'Messages éphémères : {{state}}',
  intro: {
    dm: 'Les nouveaux messages de cette conversation disparaissent pour vous deux une fois le délai écoulé.',
    group: 'Les nouveaux messages de ce groupe disparaissent pour tout le monde une fois le délai écoulé.',
    channel: 'Les nouveaux messages de ce salon disparaissent pour tout le monde une fois le délai écoulé.',
  },
  newOnly: 'Changer le délai ne concerne que les messages envoyés après le changement.',
  deleted: 'Une fois leur délai écoulé, les messages et leurs fichiers sont supprimés du serveur et des appareils de tout le monde. Les sauvegardes du serveur ne les incluent jamais.',
  honest: 'Les gens peuvent toujours faire des captures d’écran, copier du texte ou enregistrer des fichiers avant qu’un message disparaisse.',
  managersOnly: 'Seules les personnes qui peuvent gérer les salons peuvent changer ce paramètre.',
  saving: 'Enregistrement…',
  line: {
    on: '{{name}} a réglé les nouveaux messages pour qu’ils disparaissent après {{duration}}.',
    off: '{{name}} a désactivé les messages éphémères.',
    onYou: 'Tu as réglé les nouveaux messages pour qu’ils disparaissent après {{duration}}.',
    offYou: 'Tu as désactivé les messages éphémères.',
  },
  expires: 'Disparaît {{time}}',
  fallback: {
    on: 'J’ai réglé les nouveaux messages pour qu’ils disparaissent après {{duration}}. (Mets Iskra à jour pour voir le délai.)',
    off: 'J’ai désactivé les messages éphémères.',
  },
}
