import type { Messages } from '../types'

// Claim a server: become the owner of a server made from an image (DigitalOcean Marketplace) with its claim code.
export const claim: Messages['claim'] = {
  title: 'Revendiquer un serveur',
  entry: 'Tu as créé un serveur sur DigitalOcean ou sur ta propre machine et il affiche un code de revendication ? <a>Revendique-le</a>.',
  intro: 'Un nouveau serveur Iskra créé depuis le DigitalOcean Marketplace affiche son adresse et un code de revendication sur sa console (DigitalOcean : ton droplet → Console). Saisis les deux ici pour en devenir propriétaire.',
  address: 'Adresse du serveur',
  addressPlaceholder: 'https://203-0-113-7.sslip.io',
  addressHint: 'Telle qu’affichée sur la console. Une adresse IP fonctionne aussi.',
  badAddress: 'Ça ne ressemble pas à une adresse de serveur. Utilise l’adresse https:// de la console.',
  code: 'Code de revendication',
  codePlaceholder: 'XXXX-XXXX-XXXX-XXXX',
  codeHint: '16 lettres et chiffres. Les majuscules, les espaces et les tirets ne comptent pas.',
  badCode: 'Un code de revendication compte 16 lettres et chiffres, comme 7KQ2-ZM8P-X4TD-9HRA.',
  check: 'Vérifier',
  checking: 'Vérification du serveur…',
  found: 'C’est bien ton serveur. Le rejoindre en tant que propriétaire ?',
  join: 'Rejoindre en propriétaire',
  back: 'Modifier',
  errors: {
    unreachable: 'Le serveur n’a pas répondu. Vérifie l’adresse, et laisse à un serveur tout neuf quelques minutes pour démarrer et obtenir son certificat.',
    noClaim: 'Ce serveur n’attend pas de revendication : il a déjà un propriétaire, ou son code a expiré au bout de 24 heures. Pour obtenir un nouveau code, redémarre le serveur (sur la console : sudo systemctl restart iskra) et regarde à nouveau.',
    wrongCode: 'Ce code ne correspond pas à ce serveur. Vérifie chaque lettre avec la console.',
    busy: 'Trop de tentatives depuis ici. Attends une minute et réessaie.',
  },
  note: 'Le code reste sur cet appareil : l’appli vérifie seulement la preuve, fournie par le serveur, qu’il détient le même code. Il fonctionne une fois, pendant 24 heures.',
}
