import type { Messages } from '../types'

export const streamer: Messages['streamer'] = {
  title: 'Mode streamer',
  pill: 'Mode streamer',
  pillHint: 'Le mode streamer est activé : les liens d’invitation, les ID et les aperçus sont masqués, et les notifications sont discrètes. Désactive-le dans Mes paramètres ou dans ton menu de statut.',
  switch: 'Mode streamer',
  switchHint: 'Pour quand ton écran est diffusé en stream : masque les liens et codes d’invitation, les ID de compte et les numéros de sécurité, les adresses e-mail des profils et les aperçus de messages, et garde les notifications et les sons discrets. Suit ton compte sur tes autres appareils.',
  on: 'Activé',
  off: 'Désactivé',
  autoTitle: 'Activer automatiquement',
  auto: 'Quand un programme de ma liste ci-dessous est en cours',
  autoHint: 'Ajoute OBS, Streamlabs ou ton outil de stream à la liste de programmes, et le mode streamer s’active tout seul tant qu’il tourne et se désactive quand il se ferme. Seulement sur cet ordinateur, et seuls les programmes que tu as ajoutés sont recherchés.',
  autoNow: 'Un programme de ta liste est en cours : le mode streamer est activé.',
  autoDesktopOnly: 'L’appli de bureau peut aussi l’activer toute seule tant que ton programme de stream tourne :',
  hidden: 'Masqué en mode streamer',
  hiddenShort: 'Masqué',
  menu: {
    on: 'Le mode streamer est activé',
    off: 'Mode streamer',
    turnOff: 'Désactiver',
    turnOn: 'Activer',
    autoOn: 'Activé tant que ton programme de stream tourne',
  },
}
