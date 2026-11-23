import type { Messages } from '../types'

// Reclamar un servidor (español): quedar como propietario de un servidor creado desde una imagen (DigitalOcean
// Marketplace) con su código de reclamación.
export const claim: Messages['claim'] = {
  title: 'Reclamar un servidor',
  entry: '¿Creaste un servidor en DigitalOcean o en tu propia máquina y muestra un código de reclamación? <a>Reclámalo</a>.',
  intro: 'Un servidor nuevo de Iskra creado desde el DigitalOcean Marketplace muestra su dirección y un código de reclamación en su consola (DigitalOcean: tu droplet → Console). Escribe ambos aquí para quedar como su propietario.',
  address: 'Dirección del servidor',
  addressPlaceholder: 'https://203-0-113-7.sslip.io',
  addressHint: 'Como aparece en la consola. También sirve una dirección IP.',
  badAddress: 'Eso no parece la dirección de un servidor. Usa la dirección https:// de la consola.',
  code: 'Código de reclamación',
  codePlaceholder: 'XXXX-XXXX-XXXX-XXXX',
  codeHint: '16 letras y dígitos. No importan las mayúsculas, los espacios ni los guiones.',
  badCode: 'Un código de reclamación tiene 16 letras y dígitos, como 7KQ2-ZM8P-X4TD-9HRA.',
  check: 'Comprobar',
  checking: 'Comprobando el servidor…',
  found: 'Este es tu servidor. ¿Quieres unirte como su propietario?',
  join: 'Unirme como propietario',
  back: 'Cambiar',
  errors: {
    unreachable: 'El servidor no respondió. Revisa la dirección, y dale a un servidor recién creado unos minutos para iniciarse y obtener su certificado.',
    noClaim: 'Este servidor no está esperando una reclamación: ya tiene propietario, o su código venció después de 24 horas. Para obtener un código nuevo, reinicia el servidor (en la consola: sudo systemctl restart iskra) y vuelve a mirar.',
    wrongCode: 'Ese código no coincide con este servidor. Compara cada letra con la consola.',
    busy: 'Demasiados intentos desde aquí. Espera un minuto y vuelve a intentarlo.',
  },
  note: 'El código se queda en este dispositivo: la app solo comprueba la prueba que da el servidor de que tiene el mismo código. Sirve una vez, durante 24 horas.',
}
