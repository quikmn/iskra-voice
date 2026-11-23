import type { Messages } from '../types'

// Several accounts in one app (the switcher, adding one, links).
export const accounts: Messages['accounts'] = {
  switcher: {
    label: 'Comptes. Compte actuel : {{name}}',
    title: 'Comptes',
    current: 'À l’écran',
    unread_one: '{{count}} non lu',
    unread_other: '{{count}} non lus',
    otherUnread_one: '{{count}} non lu sur tes autres comptes',
    otherUnread_other: '{{count}} non lus sur tes autres comptes',
    inVoice: 'En vocal',
    locked: 'Verrouillé',
    settingUp: 'Ajout en cours',
    switchTo: 'Passer à {{name}}',
    moveUp: 'Monter {{name}}',
    moveDown: 'Descendre {{name}}',
    add: 'Ajouter un compte',
    switchAccount: 'Changer de compte',
    addNew: 'Créer un nouveau compte',
    addNewHint: 'Un compte séparé, avec son propre nom, ses serveurs et ses messages.',
    addExisting: 'Utiliser un compte que j’ai déjà',
    addExistingHint: 'Associe-le depuis un autre appareil, ou utilise sa clé de récupération.',
    full: 'Cet appareil a {{count}} comptes connectés, le maximum qu’il conserve.',
    restartNote: 'Iskra redémarre une fois pour ajouter le compte.',
    restartVoiceNote: 'Iskra redémarre une fois pour ajouter le compte, tu quitteras donc le vocal.',
    signOut: 'Déconnecter {{name}}…',
    unnamed: 'Nouveau compte',
  },
  adding: {
    cancelPlain: 'Annuler',
  },
  chooser: {
    title: 'Quel compte ?',
    invite: 'Tu as ouvert une invitation. Quel compte doit rejoindre ?',
    open: 'Quel compte doit ouvrir ce lien ?',
    cancel: 'Annuler',
  },
  linking: {
    title: 'Associer cet appareil à un autre compte ?',
    body: 'Un lien d’association d’appareil a ouvert Iskra. Ne continue que si tu as toi-même lancé l’association d’un compte à cet appareil : ce compte sera ajouté ici, à côté du tien.',
    add: 'Ajouter le compte',
    cancel: 'Annuler',
  },
  duplicate: {
    title: 'Déjà connecté ici',
    body: 'Ce compte est déjà connecté sur cet appareil. Iskra garde un seul exemplaire de chaque compte.',
    switch: 'Y aller',
  },
  voice: {
    leftAs: 'Vocal quitté avec le compte {{name}} : un seul compte peut être en vocal à la fois.',
  },
  ringing: {
    title: '{{caller}} appelle {{account}}',
    switch: 'Changer',
  },
  notifyTitle: '{{title}} · {{account}}',
  frameTitle: 'Iskra : {{name}}',
  unsupported: 'Ce navigateur ne peut pas séparer tes comptes. Utilise l’appli de bureau, ou garde un seul compte dans ce navigateur.',
}
