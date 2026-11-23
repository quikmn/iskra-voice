import type { Messages } from '../types'

// Cuenta (español): la elección del primer inicio y cerrar sesión.
export const account: Messages['account'] = {
  welcome: {
    lead: 'Chat de voz y texto con tus amigos, en servidores que son tuyos.',
    question: '¿Ya usaste Iskra antes?',
    step: 'Paso {{step}} de {{of}}',
    new: 'Es mi primera vez en Iskra',
    newHint: 'Elige un nombre y listo. Sin correo ni contraseña.',
    existing: 'Ya uso Iskra en otro dispositivo',
    existingHint: 'Vincula este dispositivo a tu cuenta, o usa tu clave de recuperación. Tus servidores, amigos y mensajes vienen contigo.',
    back: 'Atrás',
    invitedTwice: '¿Ya te uniste antes desde otro dispositivo o navegador? Elige “Ya uso Iskra”. Una cuenta nueva aparece en el servidor como una persona nueva.',
  },
  signOut: {
    button: 'Cerrar sesión en este dispositivo',
    hint: 'Quita tu cuenta solo de este dispositivo.',
    title: 'Cerrar sesión en este dispositivo',
    intro: 'Esto quita de este dispositivo las claves, los mensajes y los ajustes de tu cuenta, y quita este dispositivo de tu cuenta. Después, Iskra empieza de cero aquí.',
    otherDevices_one: 'Tu cuenta sigue en tu otro dispositivo, así que no se pierde nada.',
    otherDevices_other: 'Tu cuenta sigue en tus otros {{count}} dispositivos, así que no se pierde nada.',
    onlyDevice: 'Este es el único dispositivo con tu cuenta. Para volver a usarla necesitarás tu clave de recuperación.',
    dangerTitle: 'Perderás esta cuenta para siempre',
    danger: 'Este es tu único dispositivo y no guardaste tu clave de recuperación. Si cierras sesión ahora, nadie podrá recuperar esta cuenta: ni tú ni el propietario de un servidor.',
    saveFirst: 'Guardar primero la clave de recuperación',
    understand: 'Entiendo que esta cuenta se perderá para siempre',
    leave: 'Salir también de mis servidores',
    leaveHint: 'Tu cuenta sale de ellos en todos los dispositivos: desapareces de sus listas de miembros y necesitas una invitación nueva para volver. Sigues en los servidores que son tuyos.',
    confirm: 'Cerrar sesión',
    busy: 'Cerrando sesión…',
  },
}
