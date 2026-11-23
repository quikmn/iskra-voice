import type { Messages } from '../types'

// Rent a server on DigitalOcean (desktop app). Names of DigitalOcean's own buttons and pages stay as DigitalOcean shows them.
export const rental: Messages['rental'] = {
  title: 'Louer un serveur sur DigitalOcean',
  entry: {
    title: 'Ou laisse l’appli s’en charger, sur DigitalOcean',
    text: 'L’appli de bureau peut louer et configurer le serveur pour toi dans ton propre compte DigitalOcean : un seul bouton, environ 6 $ par mois payés à DigitalOcean.',
    button: 'Louer sur DigitalOcean',
  },
  createLink: 'Tu veux un serveur qui tourne même quand cet ordinateur est éteint ?',
  createButton: 'En louer un sur DigitalOcean',
  steps: {
    label: 'Étapes',
    account: 'Compte',
    token: 'Accès',
    place: 'Serveur',
    create: 'Installation',
  },
  account: {
    heading: 'Un compte DigitalOcean',
    intro: 'Ton serveur tourne en permanence chez DigitalOcean, un hébergeur, pour que tes amis puissent rejoindre même quand ton ordinateur est éteint. Il te faut un compte chez eux ; l’appli fait le reste.',
    cost: 'Environ <b>6 $ par mois</b> pour leur plus petit serveur adapté à Iskra (1 Go de mémoire), facturé à l’heure. Tu vois le prix exact avant toute création. Iskra est gratuit et ne facture rien.',
    credit: 'Les nouveaux comptes DigitalOcean reçoivent un crédit de bienvenue, les premiers mois peuvent donc ne rien te coûter.',
    referral: 'Iskra t’envoie chez DigitalOcean avec notre lien de parrainage : Iskra reçoit un peu de crédit DigitalOcean qui aide à payer notre propre serveur. Tu paies directement DigitalOcean ; nous ne voyons jamais ton serveur ni ta carte.',
    open: 'Ouvrir DigitalOcean',
    have: 'J’ai un compte',
  },
  connect: {
    heading: 'Connecter Iskra à DigitalOcean',
    intro: 'Connecte-toi à DigitalOcean dans ton navigateur et autorise Iskra à créer un serveur pour toi. L’appli reçoit une clé valable une heure, la garde uniquement en mémoire et l’oublie une fois l’installation terminée.',
    button: 'Connecter à DigitalOcean',
    waiting: 'On t’attend dans le navigateur…',
    cancel: 'Annuler',
    fallback: 'Utiliser plutôt un jeton d’API',
  },
  token: {
    heading: 'Laisse l’appli s’en occuper',
    intro: 'Crée une clé (un « personal access token ») qui permet à cette appli de créer le serveur pour toi. Elle reste dans la mémoire de l’appli sur cet ordinateur, n’est envoyée qu’à DigitalOcean et est jetée une fois l’installation terminée.',
    step1: 'Dans DigitalOcean, ouvre <tokens>API → Tokens</tokens> et appuie sur <b>Generate New Token</b>.',
    step2: 'Nomme-la « Iskra setup » et choisis l’<b>Expiration</b> la plus courte (30 jours, ou Custom pour un jour).',
    step3: 'Sous <b>Scopes</b>, choisis <b>Custom Scopes</b> et coche uniquement : <b>droplet</b> (create, read, delete), <b>firewall</b> (create, read, delete), <b>regions</b> (read), <b>sizes</b> (read) et <b>tag</b> (create). DigitalOcean peut cocher tout seul quelques autorisations de lecture liées ; ce n’est pas un problème.',
    step4: 'Appuie sur <b>Generate Token</b>, copie le jeton (il commence par dop_v1_) et colle-le ici.',
    label: 'Jeton',
    placeholder: 'dop_v1_…',
    next: 'Continuer',
    checking: 'Vérification auprès de DigitalOcean…',
    back: 'Retour',
  },
  place: {
    heading: 'Ton serveur',
    region: 'Lieu',
    regionHint: 'Choisis le plus proche de ton groupe, pour un vocal réactif. L’appli a deviné à partir de ton fuseau horaire.',
    regionOption: '{{name}} : {{price}} par mois',
    name: 'Nom du serveur',
    template: 'Point de départ',
    size: '{{memory}} de mémoire, {{vcpus}} CPU, {{disk}} Go de disque, Ubuntu 24.04. <b>{{price}} par mois</b>, facturé à l’heure par DigitalOcean.',
    ssh: 'Autoriser aussi SSH (accès par terminal)',
    sshHint: 'Désactivé par défaut : personne n’a besoin de s’y connecter pour faire tourner Iskra, le pare-feu ne laisse donc entrer que le web et le vocal. Tu peux l’ouvrir plus tard dans DigitalOcean.',
    note: 'Cette étape crée un serveur (un « droplet ») et un pare-feu dans ton compte DigitalOcean. Rien n’est créé avant que tu appuies sur le bouton.',
    create: 'Créer le serveur pour {{price}} par mois',
  },
  progress: {
    heading: 'Installation de {{name}}',
    droplet: 'Création du serveur chez DigitalOcean',
    firewall: 'Ajout d’un pare-feu (web et vocal uniquement)',
    booting: 'Démarrage du serveur',
    installing: 'Installation d’Iskra et obtention de son certificat HTTPS (en général 3–10 minutes)',
    claiming: 'Tu en deviens propriétaire',
    keepOpen: 'Laisse cette fenêtre ouverte ; tu peux continuer à discuter pendant ce temps.',
    address: 'Adresse : {{url}}',
    stop: 'Arrêter',
  },
  stopAsk: {
    heading: 'Arrêter l’installation ?',
    text: 'Le serveur existe déjà dans ton compte DigitalOcean et coûte de l’argent tant qu’il existe.',
    delete: 'Arrêter et le supprimer',
    keep: 'Le garder',
    back: 'Continuer',
    kept: 'Gardé. Il est dans ton compte DigitalOcean (<droplets>Droplets</droplets>) ; supprime-le là-bas si tu n’en veux pas. Pour terminer plus tard, ouvre Louer un petit serveur et connecte-toi à {{ip}}.',
  },
  failed: {
    heading: 'Ça n’a pas fonctionné',
    created: 'Un serveur a déjà été créé dans ton compte DigitalOcean. Il coûte de l’argent tant qu’il existe.',
    cleanUp: 'Le supprimer chez DigitalOcean',
    cleaning: 'Suppression…',
    cleaned: 'Supprimé. Il ne reste rien de cette tentative dans ton compte DigitalOcean.',
    cleanFailed: 'Impossible de le supprimer d’ici. Supprime-le toi-même dans DigitalOcean : le serveur sous <droplets>Droplets</droplets>, le pare-feu sous <firewalls>Networking → Firewalls</firewalls>.',
    keepWaiting: 'Continuer d’attendre',
    retry: 'Réessayer',
    detail: 'Réponse de DigitalOcean : {{detail}}',
  },
  errors: {
    token: 'DigitalOcean n’a pas accepté ce jeton. Vérifie que tu l’as copié en entier et qu’il n’a pas expiré.',
    scope: 'Il manque une autorisation à Iskra chez DigitalOcean. Reconnecte-toi et autorise tout ce qui est demandé, ou crée un nouveau jeton avec les autorisations indiquées dans les étapes du jeton.',
    limit: 'Ton compte DigitalOcean ne peut pas encore avoir un serveur de plus (les nouveaux comptes ont une limite au départ). Demande à DigitalOcean de la relever, ou supprime un serveur que tu n’utilises pas.',
    rate: 'DigitalOcean nous demande de ralentir. Attends une minute et réessaie.',
    network: 'Impossible de joindre DigitalOcean. Vérifie ta connexion Internet et réessaie.',
    server: 'DigitalOcean a rencontré un problème. Réessaie dans quelques minutes.',
    invalid: 'DigitalOcean a refusé cette demande.',
    timeoutBoot: 'Le serveur n’a pas démarré en 5 minutes.',
    timeoutInstall: 'Ton serveur n’a pas répondu en HTTPS en 25 minutes. Il est peut-être encore en cours d’installation ou en attente de son certificat.',
    cancelled: 'Arrêté.',
    busy: 'Un serveur est déjà en cours d’installation.',
    denied: 'DigitalOcean n’a pas donné l’accès à Iskra. Réessaie, ou utilise plutôt un jeton d’API.',
    unavailable: 'Mets à jour l’appli de bureau pour louer un serveur d’ici.',
  },
  done: {
    heading: 'Ton serveur est prêt',
    text: '{{name}} t’appartient. Les sauvegardes quotidiennes et les mises à jour automatiques sont activées.',
    address: 'Adresse',
    cost: 'Coût',
    costValue: '{{price}} par mois chez DigitalOcean',
    save: 'Enregistrer le document de ton serveur',
    saved: 'Enregistré',
    saveHint: 'Tout sur ton serveur dans un seul fichier : inviter des amis, les coûts et comment résilier, les mises à jour, les sauvegardes, le déménagement, et un prompt pour un assistant IA. Il ne contient ni mots de passe ni clés.',
    tokenGone: 'Le jeton a disparu de cette appli. Tu peux aussi le supprimer dans DigitalOcean (<tokens>API → Tokens</tokens>).',
    close: 'Aller sur mon serveur',
  },
  doc: {
    fileName: 'Serveur Iskra - {{name}}.md',
    title: '{{name}} : ton serveur Iskra',
    made: 'Créé par l’appli Iskra le {{date}}. Garde ce fichier. Il ne contient ni mots de passe ni clés.',
    addressTitle: 'Adresse',
    address:
      '- Adresse : {{url}}\n' +
      '- Adresse IP : {{ip}}\n' +
      '- Chez DigitalOcean : le droplet « {{droplet}} » dans {{region}} ({{size}}), avec le pare-feu « {{droplet}}-firewall ».',
    joinTitle: 'Comment tes amis rejoignent',
    join: 'Ouvre le serveur dans Iskra et appuie sur **Inviter des amis** : un lien est créé, à leur envoyer. Ils l’ouvrent dans l’appli Iskra ou dans un navigateur. Tu décides qui entre : les liens peuvent expirer ou ne fonctionner qu’une fois, et les rôles déterminent ce que chacun peut faire.',
    keysTitle: 'Tes clés et la récupération',
    keys:
      '- Tu es propriétaire. Ton compte vit sur tes propres appareils, pas sur le serveur. Garde ta **clé de récupération** (Mes paramètres → Clé de récupération) en lieu sûr : elle te rend ton compte sur un nouvel appareil.\n' +
      '- La clé et les données du serveur sont sur le serveur, dans /opt/iskra/world (server.key, iskra.db, uploads/). Ses sauvegardes quotidiennes sont dans /opt/iskra/world/backups.\n' +
      '- Les outils du propriétaire sont dans l’appli : Paramètres du serveur (membres, rôles, sauvegardes, mises à jour).',
    costTitle: 'Ce que ça coûte, et comment résilier',
    cost:
      '- {{price}} par mois, facturé à l’heure par DigitalOcean. À voir sous Billing : {{billing}}. Iskra ne facture rien.\n' +
      '- Pour arrêter de payer : dans DigitalOcean, ouvre Droplets ({{droplets}}), choisis « {{droplet}} », puis Destroy → Destroy this Droplet. Un droplet simplement éteint coûte toujours de l’argent ; le détruire y met fin. Supprime ensuite le pare-feu « {{droplet}}-firewall » sous Networking → Firewalls (gratuit, mais plus propre).\n' +
      '- Tu veux garder l’historique de ton serveur ? Crée d’abord une sauvegarde (Paramètres du serveur → Sauvegarde et déménagement).',
    updatesTitle: 'Mises à jour et sauvegardes',
    updates:
      '- Iskra se met à jour tout seul vers les nouvelles versions pendant la nuit (vers 04:00, heure du serveur, avec vérification des sommes de contrôle publiées). Paramètres du serveur → Mises à jour du serveur affiche la version et te permet de changer ça.\n' +
      '- Ubuntu installe tout seul ses propres mises à jour de sécurité.\n' +
      '- Une sauvegarde est créée chaque jour sur le serveur (les 7 dernières sont conservées). Comme elles sont sur le même serveur, télécharges-en aussi une de temps en temps : Paramètres du serveur → Sauvegarde et déménagement → Créer une sauvegarde (chiffrée avec une phrase secrète de ton choix). Les sauvegardes payantes de DigitalOcean sont désactivées.',
    moveTitle: 'Le déménager plus tard',
    move: 'Tout ton serveur tient dans un dossier. Crée une sauvegarde dans Paramètres du serveur → Sauvegarde et déménagement, restaure-la sur le nouvel ordinateur ou serveur (appli de bureau : Créer un serveur → Restaurer depuis une sauvegarde), puis utilise **Déménager ce serveur** pour que les applis de tout le monde suivent vers la nouvelle adresse. Guide : {{guide}}',
    seesTitle: 'Ce qu’Iskra peut voir ou non',
    sees:
      'Le projet Iskra ne fait rien tourner pour ton serveur et ne voit rien : ni ton serveur, ni tes messages, ni ton compte DigitalOcean, ni ton jeton, ni ta carte. L’appli n’a parlé à DigitalOcean que pendant l’installation, avec ton jeton, et l’a oublié. ' +
      'DigitalOcean, comme tout hébergeur, pourrait techniquement lire le disque du serveur ; les messages privés et les salons chiffrés sont chiffrés de bout en bout, il ne peut donc pas les lire. ' +
      'Ton serveur lui-même communique avec GitHub (mises à jour) et Let’s Encrypt (son certificat), et les serveurs de noms de sslip.io répondent pour son adresse.',
    aiTitle: 'L’aide d’un assistant IA',
    aiIntro: 'En cas de problème, colle le texte ci-dessous dans un assistant IA (Claude, ChatGPT…). Il décrit exactement ton installation et ne contient aucun secret.',
    sshOpen: 'SSH (22/tcp) est autorisé',
    sshClosed: 'SSH (22/tcp) n’est pas autorisé ; pour utiliser SSH ou la Droplet Console, ajouter d’abord à ce pare-feu une règle entrante pour TCP 22',
    ai:
      'Je fais tourner un serveur Iskra (un serveur de discussion vocale et écrite auto-hébergé, https://github.com/quikmn/iskra-voice) sur un droplet DigitalOcean. Aide-moi à résoudre un problème. Demande-moi de lancer des commandes et de coller leur résultat, en expliquant d’abord chaque commande. Voici exactement comment il a été installé :\n\n' +
      '- Droplet « {{droplet}} » dans la région {{region}}, taille {{size}}, image Ubuntu 24.04 LTS (x86-64), IPv4 publique {{ip}}.\n' +
      '- Installé au premier démarrage par un script user-data cloud-init (journal : /var/log/iskra-setup.log). Il a installé Iskra {{version}} depuis les releases GitHub (iskra-server-{{version}}-linux-x64.tar.gz, vérifié avec SHA256SUMS.txt).\n' +
      '- Programme dans /opt/iskra ; données (« world ») dans /opt/iskra/world : server.json (paramètres), iskra.db (SQLite), server.key, uploads/, backups/, certs/. Tout appartient à l’utilisateur système « iskra ».\n' +
      '- Le service systemd « iskra » (/etc/systemd/system/iskra.service) lance "/opt/iskra/iskra-server /opt/iskra/world" en tant qu’utilisateur iskra, avec ExecStartPre=-/opt/iskra/iskra-update-guard et AmbientCapabilities=CAP_NET_BIND_SERVICE. Le vocal, c’est LiveKit, que le serveur démarre lui-même.\n' +
      '- Adresse {{url}} (un nom sslip.io pour l’IP). Le serveur obtient son propre certificat HTTPS auprès de Let’s Encrypt (server.json "Https": {"Mode": "acme"}).\n' +
      '- Ports : 80/tcp (vérification du certificat), 443/tcp (web et WebSocket), 7881/tcp et 7882/udp (vocal). Ouverts dans ufw sur le droplet (avec 22/tcp) et dans le pare-feu cloud DigitalOcean « {{droplet}}-firewall » : {{ssh}}.\n' +
      '- Mises à jour automatiques depuis les releases GitHub (server.json "Updates": {"Mode": "auto"}) et sauvegardes quotidiennes dans /opt/iskra/world/backups.\n' +
      '- Journaux : journalctl -u iskra -n 200 --no-pager. État : systemctl status iskra. Santé : curl -s {{url}}/health\n' +
      '- Guide : https://iskra.foo/docs/hosting\n\n' +
      'Mon problème : <décris-le ici>',
  },
}
