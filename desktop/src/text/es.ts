// Español. Same keys as ./en; the compiler flags anything missing or extra.
import type { DesktopText } from './en'

export const text: DesktopText = {
  tray: {
    open: 'Abrir Iskra',
    about: 'Acerca de Iskra',
    check: 'Buscar actualizaciones',
    checking: 'Buscando actualizaciones…',
    downloading: (version: string) => `Descargando ${version}…`,
    restart: (version: string) => `Reiniciar para actualizar a ${version}`,
    download: (version: string) => `Descargar Iskra ${version}`,
    quit: 'Salir de Iskra',
  },
  updates: {
    titleReady: 'Actualización lista',
    titleAvailable: 'Actualización disponible',
  },
  menu: { view: 'Ver' },
  recordings: {
    pickTitle: '¿Dónde guardamos las grabaciones de llamadas?',
  },
  backup: {
    pickTitle: 'Restaurar un servidor desde una copia de seguridad',
    filter: 'Copias de seguridad de Iskra',
    notBackup: 'Ese archivo no es una copia de seguridad de Iskra.',
  },
  bots: {
    pickTitle: 'Elige un bot en el que confíes',
    pickMessage: 'Ejecuta solo bots en los que confíes: un bot se ejecuta con tus permisos en esta computadora y puede leer y cambiar tus archivos.',
    pickButton: 'Usar esta carpeta',
    warnTitle: 'Ejecuta solo bots en los que confíes',
    runQuestion: (name: string) => `¿Ejecutar “${name}” en esta computadora?`,
    autostartQuestion: (name: string) => `¿Iniciar “${name}” cada vez que se abra Iskra?`,
    changedQuestion: (name: string) => `“${name}” cambió desde la última vez que lo ejecutaste. ¿Ejecutarlo de todos modos?`,
    warnDetail: (folder: string) => `${folder}

Este bot se ejecuta con tus permisos en esta computadora: puede leer y cambiar tus archivos. Ejecuta solo bots en los que confíes.`,
    run: 'Ejecutar',
    autostart: 'Iniciarlo con Iskra',
    cancel: 'Cancelar',
  },
  template: {
    pickTitle: 'Crear un servidor desde un archivo de plantilla',
    filter: 'Plantillas de Iskra',
    tooBig: 'Ese archivo es demasiado grande para una plantilla.',
  },
  host: {
    defaultName: 'Mi servidor',
    noServer: 'Esta versión de la app no incluye el servidor.',
    stoppedEarly: 'El servidor se detuvo justo después de iniciarse. ¿Su puerto está en uso?',
    damaged: 'Los archivos del servidor están dañados, así que no puede iniciarse. El archivo server.log de su carpeta dice qué pasa; restaurar una copia de seguridad lo arregla.',
    couldntStart: (error: string) => `El servidor no pudo iniciarse: ${error}`,
    couldntRun: (error: string) => `El servidor no pudo funcionar: ${error}`,
    restoreFailed: 'No se pudo restaurar la copia de seguridad.',
    noPort: 'No se encontró ningún puerto libre.',
  },
  keys: {
    mouse: (button: number) => `Mouse ${button}`,
    key: (code: number) => `Tecla ${code}`,
  },
  passkey: {
    title: 'Llave de acceso de Iskra',
    waiting: 'Sigue las indicaciones de tu dispositivo o de tu llave de seguridad.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Iniciando Iskra…',
    servers: 'Iniciando tus servidores…',
    connecting: 'Conectando…',
    ready: 'Listo',
    updatedTo: (version: string) => `Se actualizó a ${version}`,
    updating: (version: string) => `Actualizando Iskra a ${version}…`,
    updatingDetail: 'Vuelve en unos segundos.',
  },
  assistant: {
    title: 'Asistente de Iskra',
    question: (host: string) => `¿Permitir que el asistente envíe tus preguntas a ${host}?`,
    detail: 'Di que sí solo si tú escribiste esta dirección en Mis ajustes → Asistente. Lo que le preguntes al asistente, y lo que lea por ti, se enviará allí.',
    yes: 'Sí, usarlo',
    no: 'No',
  },
  digitalOcean: {
    done: 'Conexión con DigitalOcean lista. Puedes cerrar esta pestaña y volver a Iskra.',
    denied: 'Iskra no se conectó con DigitalOcean. Puedes cerrar esta pestaña y volver a Iskra.',
  },
}
