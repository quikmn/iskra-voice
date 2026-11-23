import type { Messages } from '../types'

// The first-run choice and signing out.
export const account: Messages['account'] = {
  welcome: {
    lead: 'Discussion vocale et écrite avec tes amis, sur des serveurs qui vous appartiennent.',
    question: 'As-tu déjà utilisé Iskra ?',
    /** First run: agreeing to the terms is step 1, new or returning is step 2. */
    step: 'Étape {{step}} sur {{of}}',
    new: 'Je découvre Iskra',
    newHint: 'Choisis un nom et c’est parti. Ni e-mail, ni mot de passe.',
    existing: 'J’utilise déjà Iskra sur un autre appareil',
    existingHint: 'Associe cet appareil à ton compte, ou utilise ta clé de récupération. Tes serveurs, tes amis et tes messages suivent.',
    back: 'Retour',
    invitedTwice: 'Tu as déjà rejoint depuis un autre appareil ou navigateur ? Choisis « J’utilise déjà Iskra ». Un nouveau compte apparaît comme une nouvelle personne sur le serveur.',
  },
  signOut: {
    button: 'Se déconnecter de cet appareil',
    hint: 'Retire ton compte de cet appareil uniquement.',
    title: 'Se déconnecter de cet appareil',
    intro: 'Cette action retire de cet appareil les clés, les messages et les paramètres de ton compte, et retire cet appareil de ton compte. Iskra repart ensuite de zéro ici.',
    otherDevices_one: 'Ton compte reste sur ton autre appareil ({{count}}), rien n’est donc perdu.',
    otherDevices_other: 'Ton compte reste sur tes {{count}} autres appareils, rien n’est donc perdu.',
    onlyDevice: 'C’est le seul appareil où se trouve ton compte. Pour le réutiliser, il te faudra ta clé de récupération.',
    dangerTitle: 'Tu vas perdre ce compte pour de bon',
    danger: 'C’est ton seul appareil et tu n’as pas enregistré ta clé de récupération. Si tu te déconnectes maintenant, personne ne pourra récupérer ce compte : ni toi, ni le propriétaire d’un serveur.',
    saveFirst: 'Enregistrer d’abord la clé de récupération',
    understand: 'Je comprends que ce compte sera perdu pour de bon',
    leave: 'Quitter aussi mes serveurs',
    leaveHint: 'Ton compte les quitte sur tous les appareils : tu disparais de leurs listes de membres et il te faudra une nouvelle invitation pour revenir. Tu restes dans les serveurs qui t’appartiennent.',
    confirm: 'Se déconnecter',
    busy: 'Déconnexion…',
  },
}
