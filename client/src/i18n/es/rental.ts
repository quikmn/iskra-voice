import type { Messages } from '../types'

// Alquilar un servidor en DigitalOcean (app de escritorio): los pasos, el progreso, los errores y el documento
// “Tu servidor” (español).
export const rental: Messages['rental'] = {
  title: 'Alquilar un servidor en DigitalOcean',
  entry: {
    title: 'O deja que la app lo haga, en DigitalOcean',
    text: 'La app de escritorio puede alquilar y configurar el servidor por ti en tu propia cuenta de DigitalOcean: un botón, unos 6 USD al mes que se pagan a DigitalOcean.',
    button: 'Alquilar en DigitalOcean',
  },
  createLink: '¿Quieres un servidor que funcione incluso con esta computadora apagada?',
  createButton: 'Alquilar uno en DigitalOcean',
  steps: {
    label: 'Pasos',
    account: 'Cuenta',
    token: 'Acceso',
    place: 'Servidor',
    create: 'Instalación',
  },
  account: {
    heading: 'Una cuenta de DigitalOcean',
    intro: 'Tu servidor funciona todo el tiempo en DigitalOcean, una empresa de alojamiento, para que tus amigos puedan unirse aunque tu computadora esté apagada. Necesitas una cuenta ahí; la app hace el resto.',
    cost: 'Unos <b>6 USD al mes</b> por su servidor más pequeño en el que cabe Iskra (1 GB de memoria), cobrados por hora. Ves el precio exacto antes de que se cree nada. Iskra es gratis y no cobra nada.',
    credit: 'Las cuentas nuevas de DigitalOcean reciben crédito de bienvenida, así que puede que los primeros meses no te cuesten nada.',
    referral: 'Iskra te envía a DigitalOcean con nuestro enlace de referido: Iskra recibe un poco de crédito de DigitalOcean que ayuda a pagar nuestro propio servidor. Tú le pagas directamente a DigitalOcean; nosotros nunca vemos tu servidor ni tu tarjeta.',
    open: 'Abrir DigitalOcean',
    have: 'Ya tengo una cuenta',
  },
  connect: {
    heading: 'Conectar Iskra con DigitalOcean',
    intro: 'Inicia sesión en DigitalOcean en tu navegador y permite que Iskra cree un servidor para ti. La app recibe una clave que sirve por una hora, la guarda solo en memoria y la olvida cuando termina la instalación.',
    button: 'Conectar con DigitalOcean',
    waiting: 'Te esperamos en el navegador…',
    cancel: 'Cancelar',
    fallback: 'Mejor usar un token de API',
  },
  token: {
    heading: 'Deja que la app lo configure',
    intro: 'Crea una clave (un “personal access token”) que le permita a esta app crear el servidor por ti. Se queda en la memoria de la app en esta computadora, solo se envía a DigitalOcean, y se descarta cuando termina la instalación.',
    step1: 'En DigitalOcean, abre <tokens>API → Tokens</tokens> y presiona <b>Generate New Token</b>.',
    step2: 'Ponle el nombre “Iskra setup” y elige el valor más corto en <b>Expiration</b> (30 días, o Custom para un día).',
    step3: 'En <b>Scopes</b>, elige <b>Custom Scopes</b> y marca solo: <b>droplet</b> (create, read, delete), <b>firewall</b> (create, read, delete), <b>regions</b> (read), <b>sizes</b> (read) y <b>tag</b> (create). Puede que DigitalOcean marque por su cuenta algunos permisos de lectura relacionados; no hay problema.',
    step4: 'Presiona <b>Generate Token</b>, cópialo (empieza con dop_v1_) y pégalo aquí.',
    label: 'Token',
    placeholder: 'dop_v1_…',
    next: 'Continuar',
    checking: 'Comprobando con DigitalOcean…',
    back: 'Atrás',
  },
  place: {
    heading: 'Tu servidor',
    region: 'Ubicación',
    regionHint: 'Elige la más cercana a tu grupo, para que la voz vaya rápida. La app hizo una suposición a partir de tu zona horaria.',
    regionOption: '{{name}}: {{price}} al mes',
    name: 'Nombre del servidor',
    template: 'Punto de partida',
    size: '{{memory}} de memoria, {{vcpus}} CPU, {{disk}} GB de disco, Ubuntu 24.04. <b>{{price}} al mes</b>, que DigitalOcean cobra por hora.',
    ssh: 'Permitir también SSH (acceso por terminal)',
    sshHint: 'Desactivado de forma predeterminada: nadie necesita iniciar sesión para que Iskra funcione, así que el firewall solo deja pasar la web y la voz. Puedes abrirlo después en DigitalOcean.',
    note: 'Esto crea un servidor (un “droplet”) y un firewall en tu cuenta de DigitalOcean. No se crea nada antes de que presiones el botón.',
    create: 'Crear servidor por {{price}} al mes',
  },
  progress: {
    heading: 'Configurando {{name}}',
    droplet: 'Creando el servidor en DigitalOcean',
    firewall: 'Agregando un firewall (solo web y voz)',
    booting: 'Encendiéndolo',
    installing: 'Instalando Iskra y obteniendo su certificado HTTPS (suele tardar de 3 a 10 minutos)',
    claiming: 'Dejándote como propietario',
    keepOpen: 'Deja esta ventana abierta; mientras tanto puedes seguir chateando.',
    address: 'Dirección: {{url}}',
    stop: 'Detener',
  },
  stopAsk: {
    heading: '¿Detener la instalación?',
    text: 'El servidor ya existe en tu cuenta de DigitalOcean y cuesta dinero mientras exista.',
    delete: 'Detener y eliminarlo',
    keep: 'Conservarlo',
    back: 'Seguir',
    kept: 'Se conservó. Está en tu cuenta de DigitalOcean (<droplets>Droplets</droplets>); elimínalo ahí si no lo quieres. Para terminar más tarde, abre Alquilar un servidor pequeño y conéctate a {{ip}}.',
  },
  failed: {
    heading: 'No funcionó',
    created: 'Ya se creó un servidor en tu cuenta de DigitalOcean. Cuesta dinero mientras exista.',
    cleanUp: 'Eliminarlo en DigitalOcean',
    cleaning: 'Eliminando…',
    cleaned: 'Eliminado. No queda nada de este intento en tu cuenta de DigitalOcean.',
    cleanFailed: 'No se pudo eliminar desde aquí. Elimínalo tú en DigitalOcean: el servidor en <droplets>Droplets</droplets> y el firewall en <firewalls>Networking → Firewalls</firewalls>.',
    keepWaiting: 'Seguir esperando',
    retry: 'Volver a intentar',
    detail: 'DigitalOcean respondió: {{detail}}',
  },
  errors: {
    token: 'DigitalOcean no aceptó ese token. Comprueba que lo copiaste completo y que no venció.',
    scope: 'A Iskra le falta un permiso en DigitalOcean. Vuelve a conectar y permite todo lo que pide, o crea un token nuevo con los permisos que indican los pasos del token.',
    limit: 'Tu cuenta de DigitalOcean aún no puede tener otro servidor (las cuentas nuevas empiezan con un límite). Pídele a DigitalOcean que lo aumente, o elimina un servidor que no uses.',
    rate: 'DigitalOcean nos pide ir más despacio. Espera un minuto y vuelve a intentarlo.',
    network: 'No se pudo conectar con DigitalOcean. Revisa tu conexión a internet y vuelve a intentarlo.',
    server: 'DigitalOcean tuvo un problema. Vuelve a intentarlo en unos minutos.',
    invalid: 'DigitalOcean rechazó esa solicitud.',
    timeoutBoot: 'El servidor no se inició en 5 minutos.',
    timeoutInstall: 'Tu servidor no respondió por HTTPS en 25 minutos. Puede que todavía se esté instalando o esperando su certificado.',
    cancelled: 'Detenido.',
    busy: 'Ya se está configurando un servidor.',
    denied: 'DigitalOcean no le dio acceso a Iskra. Vuelve a intentarlo, o usa un token de API.',
    unavailable: 'Actualiza la app de escritorio para alquilar un servidor desde aquí.',
  },
  done: {
    heading: 'Tu servidor está listo',
    text: '{{name}} es tuyo. Las copias de seguridad diarias y las actualizaciones automáticas están activadas.',
    address: 'Dirección',
    cost: 'Costo',
    costValue: '{{price}} al mes en DigitalOcean',
    save: 'Guardar el documento de tu servidor',
    saved: 'Guardado',
    saveHint: 'Todo sobre tu servidor en un archivo: cómo invitar amigos, costos y cómo cancelar, actualizaciones, copias de seguridad, cómo trasladarlo, y una instrucción para un asistente de IA. No contiene contraseñas ni claves.',
    tokenGone: 'El token ya no está en esta app. También puedes eliminarlo en DigitalOcean (<tokens>API → Tokens</tokens>).',
    close: 'Ir a mi servidor',
  },
  doc: {
    fileName: 'Servidor de Iskra - {{name}}.md',
    title: '{{name}}: tu servidor de Iskra',
    made: 'Creado por la app de Iskra el {{date}}. Guarda este archivo. No contiene contraseñas ni claves.',
    addressTitle: 'Dirección',
    address:
      '- Dirección: {{url}}\n' +
      '- Dirección IP: {{ip}}\n' +
      '- En DigitalOcean: el droplet "{{droplet}}" en {{region}} ({{size}}), con el firewall "{{droplet}}-firewall".',
    joinTitle: 'Cómo se unen tus amigos',
    join: 'Abre el servidor en Iskra y presiona **Invitar amigos**: crea un enlace para enviarles. Lo abren en la app de Iskra o en un navegador. Tú decides quién entra: los enlaces pueden vencer o servir una sola vez, y los roles deciden qué puede hacer cada persona.',
    keysTitle: 'Tus claves y la recuperación',
    keys:
      '- El servidor es tuyo. Tu cuenta vive en tus propios dispositivos, no en el servidor. Guarda tu **clave de recuperación** (Mis ajustes → Clave de recuperación) en un lugar seguro: con ella recuperas tu cuenta en un dispositivo nuevo.\n' +
      '- La clave y los datos del propio servidor están en el servidor, en /opt/iskra/world (server.key, iskra.db, uploads/). Sus copias de seguridad diarias están en /opt/iskra/world/backups.\n' +
      '- Las herramientas de propietario están en la app: Ajustes del servidor (miembros, roles, copias de seguridad, actualizaciones).',
    costTitle: 'Cuánto cuesta y cómo cancelar',
    cost:
      '- {{price}} al mes, que DigitalOcean cobra por hora. Lo ves en Billing: {{billing}}. Iskra no cobra nada.\n' +
      '- Para dejar de pagar: en DigitalOcean abre Droplets ({{droplets}}), elige "{{droplet}}" y luego Destroy → Destroy this Droplet. Un droplet que solo está apagado sigue costando dinero; destruirlo lo detiene. Después elimina el firewall "{{droplet}}-firewall" en Networking → Firewalls (es gratis, pero así queda ordenado).\n' +
      '- ¿Quieres conservar el historial de tu servidor? Primero haz una copia de seguridad (Ajustes del servidor → Copia de seguridad y traslado).',
    updatesTitle: 'Actualizaciones y copias de seguridad',
    updates:
      '- Iskra se actualiza solo a las versiones nuevas por la noche (alrededor de las 04:00, hora del servidor, comprobando las sumas de comprobación publicadas). Ajustes del servidor → Actualizaciones del servidor muestra la versión y te permite cambiar esto.\n' +
      '- Ubuntu instala por su cuenta sus propias actualizaciones de seguridad.\n' +
      '- Cada día se hace una copia de seguridad en el servidor (se conservan las últimas 7). Como están en el mismo servidor, descarga una de vez en cuando: Ajustes del servidor → Copia de seguridad y traslado → Hacer copia de seguridad (cifrada con una frase de contraseña que tú eliges). Las copias de seguridad de pago de DigitalOcean están desactivadas.',
    moveTitle: 'Trasladarlo más adelante',
    move: 'Todo tu servidor es una carpeta. Haz una copia de seguridad en Ajustes del servidor → Copia de seguridad y traslado, restáurala en la computadora o el servidor nuevo (app de escritorio: Crear un servidor → Restaurar desde una copia de seguridad) y luego usa **Trasladar este servidor** para que la app de todos siga a la dirección nueva. Guía: {{guide}}',
    seesTitle: 'Qué puede ver Iskra y qué no',
    sees:
      'El proyecto Iskra no administra nada de tu servidor y no ve nada: ni tu servidor, ni tus mensajes, ni tu cuenta de DigitalOcean, ni tu token, ni tu tarjeta. La app habló con DigitalOcean solo durante la instalación, con tu token, y ya lo olvidó. ' +
      'DigitalOcean, como cualquier empresa de alojamiento, técnicamente podría leer el disco del servidor; los mensajes directos y los canales cifrados están cifrados de extremo a extremo, así que esos no puede leerlos. ' +
      'Tu servidor se comunica con GitHub (actualizaciones) y con Let\'s Encrypt (su certificado), y los servidores de nombres de sslip.io responden por su dirección.',
    aiTitle: 'Ayuda de un asistente de IA',
    aiIntro: 'Si algo sale mal, pega el texto de abajo en un asistente de IA (Claude, ChatGPT…). Describe tu instalación con exactitud y no contiene secretos.',
    sshOpen: 'SSH (22/tcp) está permitido',
    sshClosed: 'SSH (22/tcp) no está permitido; para usar SSH o la Droplet Console, primero agrega a ese firewall una regla de entrada para TCP 22',
    ai:
      'Tengo un servidor de Iskra (un servidor de voz y chat autoalojado, https://github.com/quikmn/iskra-voice) en un droplet de DigitalOcean. Ayúdame con un problema. Pídeme que ejecute comandos y que pegue su resultado, y explícame antes cada comando. Así es exactamente como se configuró:\n\n' +
      '- Droplet "{{droplet}}" en la región {{region}}, tamaño {{size}}, imagen Ubuntu 24.04 LTS (x86-64), IPv4 pública {{ip}}.\n' +
      '- Se configuró en el primer arranque con un script de user-data de cloud-init (registro: /var/log/iskra-setup.log). Instaló Iskra {{version}} desde las versiones publicadas en GitHub (iskra-server-{{version}}-linux-x64.tar.gz, comprobado con SHA256SUMS.txt).\n' +
      '- El programa está en /opt/iskra; los datos ("world") en /opt/iskra/world: server.json (ajustes), iskra.db (SQLite), server.key, uploads/, backups/, certs/. Todo pertenece al usuario del sistema "iskra".\n' +
      '- El servicio de systemd "iskra" (/etc/systemd/system/iskra.service) ejecuta "/opt/iskra/iskra-server /opt/iskra/world" como el usuario iskra, con ExecStartPre=-/opt/iskra/iskra-update-guard y AmbientCapabilities=CAP_NET_BIND_SERVICE. La voz es LiveKit, que el propio servidor inicia.\n' +
      '- Dirección {{url}} (un nombre de sslip.io para la IP). El servidor obtiene su propio certificado HTTPS de Let\'s Encrypt (server.json "Https": {"Mode": "acme"}).\n' +
      '- Puertos: 80/tcp (comprobación del certificado), 443/tcp (web y WebSocket), 7881/tcp y 7882/udp (voz). Abiertos en ufw en el droplet (junto con 22/tcp) y en el firewall de DigitalOcean "{{droplet}}-firewall": {{ssh}}.\n' +
      '- Actualizaciones automáticas desde las versiones de GitHub (server.json "Updates": {"Mode": "auto"}) y copias de seguridad diarias en /opt/iskra/world/backups.\n' +
      '- Registros: journalctl -u iskra -n 200 --no-pager. Estado: systemctl status iskra. Salud: curl -s {{url}}/health\n' +
      '- Guía: https://iskra.foo/docs/hosting\n\n' +
      'Mi problema: <descríbelo aquí>',
  },
}
