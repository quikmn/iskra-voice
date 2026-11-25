# Glossaire français (fr)

French terms for Iskra. Same sections and English terms as [`../i18n-glossary.md`](../i18n-glossary.md), plus the
terms decided for French. Rules: [translating.md](../translating.md).

## Decided for the whole language

- **Form of address: "tu".** Discord, Twitch, Snapchat, Duolingo and most games address people with "tu" in French,
  and Iskra is for groups of friends. "Vous" reads as a bank or an office tool. "Vous" is used only when the text
  really speaks to several people at once ("Vous êtes 3 dans l'appel").
- **Buttons, menu items and tabs use the infinitive** ("Enregistrer", "Inviter des amis", "Quitter le serveur"), as
  French interfaces do. Instructions and hints speak to the person with the imperative or "tu" ("Choisis un nom",
  "Tu peux changer ça plus tard").
- **No assumed gender.** Word sentences so that no participle or adjective agrees with the person ("Connexion
  réussie" instead of "Tu es connecté", "Bienvenue", "{{name}} a rejoint le serveur", "Supprimer ce message ?"
  instead of "Es-tu sûr ?"). No "(e)" and no "·e". Role names and generic nouns keep their usual form
  (propriétaire, modérateur, invité, ami, utilisateur).
- **Sentence case.** Only the first word and proper names take a capital: "Paramètres du serveur", "Mes paramètres".
  Capitals keep their accents: "Événements", "À propos", "Émojis".
- **French of France, understood everywhere.** No slang, no France-only words, no anglicism where a normal French
  word exists ("serveur", "salon", "télécharger", "mot de passe"). Loanwords French speakers really use stay: bot,
  webhook, GIF, émoji, clip, lobby, streamer, e-mail.
- **Typography.**
  - A non-breaking space (U+00A0) before `:` `;` `!` `?` and inside the guillemets: `Supprimer ce message ?`,
    `« texte »`. No space before `,` `.` `…`.
  - Quotation marks are `« … »`, never `"…"`.
  - The apostrophe is the typographic one, `’` (U+2019): `l’appli`, `aujourd’hui`.
  - `…` is one character. Ranges keep the en dash without spaces: `1–32`.
  - Numbers: a non-breaking space before `%` and between a number and Ko, Mo, Go, € or $ (`5 Mo`, `50 %`, `6 $`);
    decimal comma (`2,5`).
  - Units: Ko, Mo, Go (not KB, MB, GB), `min`, `h`, `s`, `j` for days. Money as in the source ("6 $ par mois").
  - "ex. : " for "e.g.". "OK" stays "OK".
- **Elision with variables.** A name is inserted as it is, so avoid "de {{name}}" where it can be avoided cheaply
  ("Message de {{name}}" is accepted: French interfaces do this). Never write "d'{{name}}" or "l'{{thing}}".
- **A name or "toi" in the same slot.** Some lines get "you" put in where a name goes (`groups.you`,
  `groups.change.youSubject`). A French verb would have to agree ("Tu as", "Anna a"), so those lines have no verb
  after the slot: "Groupe créé par {{who}} avec {{targets}}", "Appel vidéo lancé par {{who}}", and "you" is "toi".
- **Bot commands.** The built-in bots read English command words, so examples keep them: `/remind me in 10m sortir
  la pizza`, `/birthday set 14/3`, `/tag list`, `/giveaway end`. Dates in examples are written `14/3`, which the
  bot reads in every language. The built-in bots' names (Dice, Polls, Reminders, Feeds…) are the same in every
  language: "le bot Feeds".
- **Other sites' buttons** are named as that site shows them (DigitalOcean "Generate New Token", Tailscale
  "Share…", KLIPY "Create API Key").
- **Key names** stay as printed in the English texts (Ctrl, Shift, Esc, Enter, Tab, Delete).
- **Plurals.** `_one` is used for 0 and 1 and always contains `{{count}}`: "{{count}} membre", "{{count}} membres".

## People and places

| English | Français | Notes |
|---|---|---|
| Name | Nom | Your Iskra name |
| Server nickname | Pseudo sur le serveur ("Pseudo sur {{server}}") | Reset: "Utiliser mon nom" |
| Owner, Admin, Moderator, Trusted, Member, Guest | Propriétaire, Admin, Modérateur, De confiance, Membre, Invité | Plural "admins" in running text. "membre de confiance" in a sentence |
| Role | Rôle | Never "niveau" or "grade" |
| Built-in role (badge "Built-in") | Rôle intégré (badge « Intégré ») | Custom roles: "rôles personnalisés" |
| Permission | Permission | Never "droit" or "autorisation" for what a role allows. "Autorisation" is for the browser or system (micro, notifications) |
| Bot, bots | Bot, bots | |
| Server | Serveur | |
| Channel, text channel, voice channel | Salon, salon textuel, salon vocal | The word French chat apps use. Never "canal" or "chaîne". "En vocal" for "in voice" |
| Stage | Scène | |
| Thread | Fil | "Fil de discussion" where "fil" alone is unclear |
| Forum post | Sujet | Forum channel: "salon forum". Its answers: "réponses" |
| Direct message(s) | Message(s) privé(s) | "MP" only as a short tab label, never in sentences |
| Group chat | Discussion de groupe | Short: "groupe". Never "MP de groupe" |
| Device | Appareil | |
| Account | Compte | |

## Settings

| English | Français | Notes |
|---|---|---|
| My settings | Mes paramètres | "Paramètres", never "réglages" or "préférences" |
| Language (section) | Langue | |
| Server settings | Paramètres du serveur | |
| Server, Members & safety, Apps, Hosting & data (groups) | Serveur, Membres et sécurité, Applis, Hébergement et données | "&" becomes "et" |
| Overview | Vue d’ensemble | |
| Server icon, banner | Icône du serveur, bannière | |
| Channels | Salons | |
| Emoji & stickers | Émojis et autocollants | |
| GIFs | GIF | Invariable |
| Soundboard | Boîte à sons | |
| Profile pages | Pages de profil | |
| Server rules | Règles du serveur | |
| Members | Membres | |
| Roles | Rôles | |
| Reports | Signalements | |
| AutoMod (nav and heading) | AutoMod | |
| Audit log | Journal d’audit | Never "journal d'activité" (activity is games) |
| Sign-ins & security | Connexions et sécurité | |
| Bots & webhooks | Bots et webhooks | |
| Internet access (section) / Open to the internet (its switch) | Accès Internet / Ouvrir à Internet | |
| Limits | Limites | |
| Backup & move | Sauvegarde et transfert | The section's name, short enough for the settings list. To move a server: "déménager le serveur", "le déménagement" |
| Import from Discord | Importer depuis Discord | |
| Server updates | Mises à jour du serveur | |
| Notifications | Notifications | |
| Recovery key | Clé de récupération | Recovery code: "code de récupération" |
| App lock | Verrouillage de l’appli | |

## Actions

| English | Français | Notes |
|---|---|---|
| Invite friends | Inviter des amis | |
| Invite link | Lien d’invitation | An invite: "une invitation" |
| Hide server (only off your list) | Masquer le serveur | |
| Leave server (really leaves) | Quitter le serveur | |
| Sign out | Se déconnecter | Sign in: "Se connecter". Sign-in (noun): "connexion" |
| Kick | Expulser | |
| Ban, unban | Bannir, débannir | Noun: "bannissement" |
| Time out / timeout | Exclure temporairement / exclusion temporaire | Short label where space is tight: "Exclusion". End it: "Lever l’exclusion" |
| Slowmode | Mode lent | |
| Mute (yourself) / Deafen | Couper le micro / Couper le son | Back on: "Réactiver le micro" / "Réactiver le son". States: "Micro coupé", "Son coupé" |
| Mute (someone else, for you) / Server mute | Rendre muet / Rendre muet sur le serveur | Undo: "Rétablir le son". State: "Muet sur le serveur" |
| Push to talk | Appuyer pour parler | |
| Pin, unpin | Épingler, désépingler | Pinned messages: "messages épinglés" |
| Report (noun) | Signalement | Verb: "signaler" |
| Upload | Importer | A file you add: "Importer une image". Never "uploader", "téléverser" |
| Preview | Aperçu | Verb: "Prévisualiser" only where a verb is needed |
| Delete / Remove | Supprimer / Retirer | "Supprimer" destroys; "Retirer" takes out of a list or a group |
| Optional | Facultatif | |
| e.g. (example placeholders: "e.g. game-night") | ex. : (« ex. : soirée-jeux ») | |

## Features

| English | Français | Notes |
|---|---|---|
| Mention | Mention (verb: mentionner) | |
| Poll | Sondage | |
| Teams (team splitter; one team, "Team 1") | Équipes (répartition en équipes ; une équipe, « Équipe 1 ») | |
| Looking for group (LFG post) | Recherche de joueurs (the post: "annonce") | |
| Event | Événement | Spelled "événement", not "évènement" |
| Sticker | Autocollant | |
| Emoji | Émoji, émojis | |
| Watch party | Regarder ensemble | As a name, also in running text: "dans Regarder ensemble" |
| Clip | Clip | |
| Catch up | Rattrapage | Verb: "rattraper" |
| Passkey | Clé d’accès | The term Apple, Google and Microsoft use in French |
| Passphrase | Phrase secrète | |
| End-to-end encrypted | Chiffré de bout en bout | Never "crypté" |
| Decrypt | Déchiffrer | Never "décrypter" |
| Backup | Sauvegarde | Verb: "sauvegarder" |

## More terms decided for French

| English | Français | Notes |
|---|---|---|
| App | Appli | "l’appli de bureau" (desktop app), "l’appli mobile". Never "logiciel" |
| Save / Saved | Enregistrer / Enregistré | |
| Cancel, Close, Edit, Done | Annuler, Fermer, Modifier, Terminé | |
| Back, Next, Continue | Retour, Suivant, Continuer | |
| Copy / Copied / Copy link | Copier / Copié / Copier le lien | |
| Retry, Try again | Réessayer | |
| Loading… | Chargement… | |
| Create, Add, Send | Créer, Ajouter, Envoyer | |
| Join / Leave | Rejoindre / Quitter | |
| Search | Rechercher (button, field), recherche (noun) | |
| Download | Télécharger | |
| Settings | Paramètres | |
| On / Off | Activé / Désactivé | Turn on / off: "Activer" / "Désactiver" |
| Message, reply, reaction | Message, réponse (répondre), réaction | |
| Attachment | Pièce jointe | |
| Draft | Brouillon | |
| Unread / Mark as read | Non lu / Marquer comme lu | |
| Mute (a channel's or server's notifications) | Mettre en sourdine | Undo: "Réactiver les notifications" |
| Category | Catégorie | |
| Friend, friend request | Ami, demande d’ami | |
| Block / Unblock | Bloquer / Débloquer | |
| Online, Idle, Do not disturb, Invisible, Offline | En ligne, Inactif, Ne pas déranger, Invisible, Hors ligne | |
| Status, custom status | Statut, statut personnalisé | |
| AFK channel | Salon AFK | |
| Voice / in voice | Vocal / en vocal | |
| Call, group call | Appel, appel de groupe | Hang up or leave a call: "Quitter l’appel" |
| Disconnect (voice) | Quitter le vocal | "Se déconnecter" is only for signing out |
| Connection (network) | Connexion | "Connexion perdue", "Reconnexion…" |
| Camera, screen share | Caméra, partage d’écran | "Partager l’écran" |
| Speaker, headphones, microphone | Haut-parleurs, casque, micro | |
| Record / recording (a call) | Enregistrer / enregistrement | |
| Room (join-to-create voice room), lobby, host | Salle, lobby, hôte | A room is not a channel, so not "salon" |
| Whisper, priority speaker | Chuchoter (chuchotement), voix prioritaire | |
| Stage: speaker, audience, raise hand | Sur scène, public, lever la main | |
| Whiteboard | Tableau blanc | |
| Docs channel, document | Salon de documents, document | |
| Media channel | Salon média | |
| Activities, Trivia, Draw & guess | Activités, Quiz, Dessine et devine | |
| Feeds (bot), feed | Flux | |
| Reminder | Rappel | |
| Saved messages | Messages enregistrés | |
| Scheduled message | Message programmé | |
| Inbox | Boîte de réception | |
| Disappearing messages | Messages éphémères | |
| Favourites | Favoris | |
| Alert word, quiet hours | Mot d’alerte, heures calmes | |
| Follow | Suivre | |
| Password | Mot de passe | |
| Email | E-mail | |
| Username | Nom d’utilisateur | |
| Shortcut, keybind | Raccourci | |
| Template | Modèle | |
| Host / hosting / self-hosted | Héberger / hébergement / auto-hébergé | |
| Rent a server | Louer un serveur | |
| Claim a server, claim code | Revendiquer un serveur, code de revendication | Not "récupération", which is the recovery key and the recovery code |
| Backup buddy, pairing code | Ami de sauvegarde, code d’association | |
| Update / updated | Mise à jour / mis à jour | "Mettre à jour" |
| What's new | Nouveautés | |
| Streamer mode | Mode streamer | |
| Translate / translation | Traduire / traduction | |
| Read aloud, captions, transcript | Lire à voix haute, sous-titres, transcription | |
| Assistant | Assistant | |
| Slash command | Commande | `/roll` itself is never translated |
| Tag (the Tags bot: saved snippets, `/tag`) | Tag | |
| Tag (forum, media channel) | Étiquette | |
| Giveaway, enter, reroll, prize | Tirage au sort, participer, relancer le tirage, lot | |
| Suggestion (the Suggestions bot) | Suggestion | Staff: "l’équipe" |
| Counting (channel) | Comptage | |
| Starboard | Tableau (of the Starboard bot) | The bot's name stays "Starboard" |
| Comment (media post) | Commentaire | |
| Media post | Publication | A forum post is a "sujet" |
| Topic (channel, stage) | Sujet | |
| Label (invite) | Libellé | |
| Signing secret | Secret de signature | |
| Token (API) | Jeton | |
| Queue (watch together) | File d’attente | |
| Spot (backup buddies) | Emplacement | |
| Key transparency, key log | Transparence des clés, journal des clés | |
| Security log | Journal de sécurité | |
| Data retention | Conservation des données | |
| Tray (desktop) | Zone de notification | |
| Keychain | Trousseau | |
| Sandbox | Bac à sable | |
| Staff (server staff) | Équipe (du serveur) | |
| Newcomer | Nouveau | "Mode lent des nouveaux" |
| Dismiss | Ignorer | A report: "Classer sans suite" |
| Home (start page) | Accueil | |
| Hand over / transfer ownership | Céder le serveur / Transférer la propriété | |
| Peer-to-peer | Pair-à-pair | |
| Live (stage, event, stream) | En direct | |
| Round (game) | Manche | |
| Four in a row | Puissance 4 | The name the game has in French |
| Outgoing / incoming webhook | Webhook sortant / entrant | |
| Join questions | Questions d’arrivée | |
| Warn / warning (moderation) | Avertir / avertissement | |
| Note (moderation) | Note | |
| Bug report, bug inbox | Rapport de bug, rapports de bugs | "Signaler un bug". Iskra's own inbox: "service de rapports de bugs" |
| Public page | Page publique | |
| Export | Exporter / export | |
| Link preview | Aperçu de lien | |
| Tap, click | Appuyer, cliquer | "Appuie pour répondre" |
| Pop out, picture-in-picture | Détacher, image dans l’image | |
| Sign up / create an account | Créer un compte | |
| Verify, safety number | Vérifier, numéro de sécurité | |
| Key (encryption) | Clé | |
| Port forwarding | Redirection de port | |
| Firewall, router | Pare-feu, routeur (box) | "box" is France-only: write "routeur" |
| Computer / phone | Ordinateur / téléphone | Never "PC": "Bots sur cet ordinateur" |
| Link a device | Associer un appareil | "Association", "code d’association" (also the backup buddies' pairing code) |
| Privacy & data (section) | Vie privée et données | Elsewhere "confidentialité": "Politique de confidentialité", "Confidentialité et sécurité" (group) |
| About & legal (section) | À propos | The longer "À propos et mentions légales" doesn't fit the settings list |
| Message request | Demande de message | |
| Safety number | Numéro de sécurité | |
| Voice message | Message vocal | |
| Screenshot | Capture d’écran | |
| Starter template | Modèle de départ | |
| Folder / file | Dossier / fichier | |

## Task boards

| English | Français | Notes |
|---|---|---|
| Task board (the channel kind "Tasks") | Tableau de tâches (kind: « Tâches ») | Short: "tableau" ("Retour au tableau"). The whiteboard stays "tableau blanc" |
| Task | Tâche | Feminine: "Créée par", "modifiée", "archivée" agree with it |
| To do / Doing / Done (the columns) | À faire / En cours / Terminé | "Terminé" stays invariable as a column and status name; in a sentence "les tâches terminées" |
| Assign, assigned to, "Assign me" | Attribuer, attribuée à, « Me l’attribuer » | Never "assigner". Unassign me: "Me retirer". "{{name}} t’a attribué une tâche" |
| Label (on a task; a forum has tags) | Étiquette | The same word as a forum's tag: it is what French task boards call it. "Libellé" is only an invite's label |
| Due (a task's due day) | Échéance | "Pour le {{date}}", "Pour aujourd’hui"; passed: "C’était pour le {{date}}"; none: "Pas d’échéance" |
| Archive, archived (a done task put away) | Archiver, archivée | Put back: "Remettre sur le tableau" |
| Comment (on a task) | Commentaire | |

## Photos channels

| English | Français | Notes |
|---|---|---|
| Photos channel (the channel kind "Photos") | Salon photos (kind: « Photos ») | Like "salon média". Plural "salons photos" |
| Photo, video | Photo, vidéo | Both feminine: "Ajoutée le", "sélectionnées", "Ajoutées par" agree with them. "Image" only for the file type and the pixels ("Les images elles-mêmes") |
| Album / "No album" | Album / « Sans album » | Audit log filter: "Albums photo" |
| Add photos | Ajouter des photos | Never "importer" for the action; "Import" only for the upload step |
| Date taken | Date de prise de vue | "Prise le {{taken}}" |
| Caption | Légende | The same word as in a media channel. "Sous-titres" is only for live captions |
| Storage / storage limit | Stockage / limite de stockage | "{{used}} utilisés sur {{cap}}". Sizes in Mo, Go |
| Cover (album cover) | Couverture | "Utiliser comme couverture de l’album" |
| Hidden data / metadata | Données cachées / métadonnées | "Métadonnées" only in the server error; the app says "données cachées" and names them (le lieu, les informations sur l’appareil photo et le téléphone). Remove: "retirer" |
| Select | Sélectionner | "{{count}} sélectionnées", "Tout sélectionner" |
| Download album | Télécharger l’album | All: "Tout télécharger". The file: "le zip" |
| Thumbnail | Miniature |  |
