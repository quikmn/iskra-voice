import type { Messages } from '../types'

export const voiceStatus: Messages['voiceStatus'] = {
  label: 'Status do canal de voz',
  none: 'Ainda sem status',
  set: 'Definir um status',
  edit: 'Mudar o status',
  placeholder: 'ex.: CS2 ranqueado',
  save: 'Salvar',
  clear: 'Limpar',
  setBy: 'Status definido por {{name}}',
  tooLong: 'Até {{max}} caracteres.',
  invalid: 'Uma linha, sem caracteres invisíveis.',
  hint: 'Todo mundo que consegue ver o canal vê o status. Ele some quando todos saem.',
  encrypted: 'A voz aqui é criptografada de ponta a ponta, mas o status não: o servidor e todo mundo que consegue ver o canal podem lê-lo. Ele some quando todos saem.',
  clearMenu: 'Limpar status da voz',
}
