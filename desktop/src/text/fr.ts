// Français. Same keys as ./en; the compiler flags anything missing or extra.
import type { DesktopText } from './en'

export const text: DesktopText = {
  tray: {
    open: 'Ouvrir Iskra',
    about: 'À propos d’Iskra',
    check: 'Rechercher des mises à jour',
    checking: 'Recherche de mises à jour…',
    downloading: (version) => `Téléchargement de ${version}…`,
    restart: (version) => `Redémarrer pour passer à ${version}`,
    download: (version) => `Télécharger Iskra ${version}`,
    quit: 'Quitter Iskra',
  },
  updates: {
    titleReady: 'Mise à jour prête',
    titleAvailable: 'Mise à jour disponible',
  },
  menu: { view: 'Affichage' },
  recordings: {
    pickTitle: 'Où ranger les enregistrements d’appels ?',
  },
  backup: {
    pickTitle: 'Restaurer un serveur depuis une sauvegarde',
    filter: 'Sauvegardes Iskra',
    notBackup: 'Ce fichier n’est pas une sauvegarde Iskra.',
  },
  bots: {
    pickTitle: 'Choisis un bot de confiance',
    pickMessage: 'Ne lance que des bots de confiance : un bot s’exécute avec tes droits sur cet ordinateur et peut lire et modifier tes fichiers.',
    pickButton: 'Utiliser ce dossier',
    warnTitle: 'Ne lance que des bots de confiance',
    runQuestion: (name) => `Lancer « ${name} » sur cet ordinateur ?`,
    autostartQuestion: (name) => `Lancer « ${name} » à chaque démarrage d’Iskra ?`,
    changedQuestion: (name) => `« ${name} » a changé depuis son dernier lancement. Le lancer quand même ?`,
    warnDetail: (folder) => `${folder}

Ce bot s’exécute avec tes droits sur cet ordinateur : il peut lire et modifier tes fichiers. Ne lance que des bots de confiance.`,
    run: 'Lancer',
    autostart: 'Le lancer avec Iskra',
    cancel: 'Annuler',
  },
  template: {
    pickTitle: 'Créer un serveur à partir d’un fichier modèle',
    filter: 'Modèles Iskra',
    tooBig: 'Ce fichier est trop volumineux pour un modèle.',
  },
  host: {
    defaultName: 'Mon serveur',
    noServer: 'Cette version n’inclut pas le serveur.',
    stoppedEarly: 'Le serveur s’est arrêté juste après son démarrage. Son port est peut-être déjà utilisé.',
    damaged: 'Les fichiers du serveur sont endommagés, il ne peut donc pas démarrer. Le fichier server.log de son dossier indique le problème ; restaurer une sauvegarde le règle.',
    couldntStart: (error) => `Le serveur n’a pas pu démarrer : ${error}`,
    couldntRun: (error) => `Le serveur n’a pas pu fonctionner : ${error}`,
    restoreFailed: 'La sauvegarde n’a pas pu être restaurée.',
    noPort: 'Aucun port libre trouvé.',
  },
  keys: {
    mouse: (button) => `Souris ${button}`,
    key: (code) => `Touche ${code}`,
  },
  passkey: {
    title: 'Clé d’accès Iskra',
    waiting: 'Suis les instructions de ton appareil ou de ta clé de sécurité.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Démarrage d’Iskra…',
    servers: 'Démarrage de tes serveurs…',
    connecting: 'Connexion…',
    ready: 'Prêt',
    updatedTo: (version) => `Mise à jour vers ${version} terminée`,
    updating: (version) => `Mise à jour d’Iskra vers ${version}…`,
    updatingDetail: 'De retour dans quelques secondes.',
  },
  assistant: {
    title: 'Assistant Iskra',
    question: (host) => `Autoriser l’assistant à envoyer tes questions à ${host} ?`,
    detail: 'Ne réponds oui que si tu as saisi cette adresse toi-même dans Mes paramètres → Assistant. Ce que tu demandes à l’assistant, et ce qu’il lit pour toi, y sera envoyé.',
    yes: 'Oui, l’utiliser',
    no: 'Non',
  },
  digitalOcean: {
    done: 'Connexion à DigitalOcean réussie. Tu peux fermer cet onglet et revenir à Iskra.',
    denied: 'Iskra n’a pas été connecté à DigitalOcean. Tu peux fermer cet onglet et revenir à Iskra.',
  },
}
