import type { Messages } from '../types'

// Cuentas (español): varias cuentas en una app (el selector, agregar una, enlaces).
export const accounts: Messages['accounts'] = {
  switcher: {
    label: 'Cuentas. Sesión iniciada como {{name}}',
    title: 'Cuentas',
    current: 'En pantalla',
    unread_one: '{{count}} sin leer',
    unread_other: '{{count}} sin leer',
    otherUnread_one: '{{count}} sin leer en tus otras cuentas',
    otherUnread_other: '{{count}} sin leer en tus otras cuentas',
    inVoice: 'En voz',
    locked: 'Bloqueada',
    settingUp: 'Agregándose',
    switchTo: 'Cambiar a {{name}}',
    moveUp: 'Subir {{name}}',
    moveDown: 'Bajar {{name}}',
    add: 'Agregar cuenta',
    switchAccount: 'Cambiar de cuenta',
    addNew: 'Crear una cuenta nueva',
    addNewHint: 'Una cuenta aparte, con su propio nombre, servidores y mensajes.',
    addExisting: 'Usar una cuenta que ya tengo',
    addExistingHint: 'Vincúlala desde otro dispositivo, o usa su clave de recuperación.',
    full: 'Este dispositivo tiene {{count}} cuentas con sesión iniciada, el máximo que admite.',
    restartNote: 'Iskra se reinicia una vez para agregar la cuenta.',
    restartVoiceNote: 'Iskra se reinicia una vez para agregar la cuenta, así que saldrás de la voz.',
    signOut: 'Cerrar sesión de {{name}}…',
    unnamed: 'Cuenta nueva',
  },
  adding: {
    cancelPlain: 'Cancelar',
  },
  chooser: {
    title: '¿Con qué cuenta?',
    invite: 'Abriste una invitación. ¿Qué cuenta quieres que se una?',
    open: '¿Con qué cuenta quieres abrir este enlace?',
    cancel: 'Cancelar',
  },
  linking: {
    title: '¿Vincular este dispositivo a otra cuenta?',
    body: 'Un enlace para vincular un dispositivo abrió Iskra. Continúa solo si tú empezaste a vincular una cuenta a este dispositivo: se agregará esa cuenta aquí, junto a la tuya.',
    add: 'Agregar la cuenta',
    cancel: 'Cancelar',
  },
  duplicate: {
    title: 'Ya tiene sesión iniciada aquí',
    body: 'Esta cuenta ya tiene sesión iniciada en este dispositivo. Iskra guarda una sola copia de cada cuenta.',
    switch: 'Ir a ella',
  },
  voice: {
    leftAs: 'Saliste de la voz como {{name}}: solo una cuenta puede estar en voz a la vez.',
  },
  ringing: {
    title: '{{caller}} está llamando a {{account}}',
    switch: 'Cambiar',
  },
  notifyTitle: '{{title}} · {{account}}',
  frameTitle: 'Iskra: {{name}}',
  unsupported: 'Este navegador no puede mantener tus cuentas separadas. Usa la app de escritorio, o usa una sola cuenta en este navegador.',
}
