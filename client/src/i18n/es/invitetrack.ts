import type { Messages } from '../types'

// Etiquetas de invitación y con qué invitación se unió cada persona (moderadores), y los formatos de webhooks
// entrantes y sus secretos de firma (español).
export const invitetrack: Messages['invitetrack'] = {
  label: 'Etiqueta',
  labelPlaceholder: 'Opcional, p. ej. Publicación en Reddit',
  labelHint: 'Los moderadores ven con qué invitación se unió cada persona. Una etiqueta les dice dónde se compartió.',
  named: '“{{label}}”',
  unnamed: 'invitación {{id}}',
  via: 'Se unió con {{invite}}',
  viaFrom: 'Se unió con {{invite}} de {{name}}',
  approved: '{{text}}, con el visto bueno de {{name}}',
  setupLink: 'la instalación',
  someone: 'alguien',
  notTracked: 'Se unió antes de que se registraran las invitaciones',
  filter: 'Se unió con',
  filterAny: 'Cualquier invitación',
  filterOption: '{{invite}} ({{count}})',
  audit: {
    join: '{{target}} se unió con {{invite}}',
  },
  formats: {
    label: 'Formato',
    hint: 'Elige el servicio donde vas a pegar esto. Los eventos sobre los que Iskra no publica se omiten.',
    discord: 'Tipo Discord',
    github: 'GitHub',
    gitea: 'Gitea',
    gitlab: 'GitLab',
    slack: 'Slack',
  },
  signing: {
    button: 'Secreto de firma',
    title: 'Secreto de firma de {{name}}',
    intro: 'Pega el mismo secreto en el campo “Secret” de GitHub o Gitea, o en “Secret token” de GitLab. Después, lo que se publique en /github, /gitea y /gitlab debe ir firmado con él, así que la URL sola no basta.',
    onlySigned: 'Con un secreto, este webhook solo acepta publicaciones firmadas de GitHub, Gitea o GitLab: las URL simple y de Slack dejan de funcionar.',
    suggest: 'Consejo: después de crearlo, haz clic en Secreto de firma para que solo {{service}} pueda publicar aquí.',
    secret: 'Secreto',
    generate: 'Generar',
    save: 'Guardar',
    remove: 'Quitar',
    copyNow: 'Cópialo ahora: no se volverá a mostrar.',
    on: 'firmado',
    length: 'Usa de {{min}} a {{max}} caracteres.',
    characters: 'Usa letras, dígitos, símbolos y espacios (no al principio ni al final).',
  },
}
