import type { Messages } from '../types'

export const presence: Messages['presence'] = {
  status: {
    online: 'Online',
    idle: 'Ausente',
    dnd: 'Não perturbe',
    invisible: 'Invisível',
    offline: 'Offline',
  },
  hints: {
    idle: 'Também é definido automaticamente quando você se afasta',
    dnd: 'Sem sons nem notificações',
    invisible: 'Você aparece offline, mas pode usar o Iskra normalmente',
  },
  clearAfter: {
    '30m': '30 minutos',
    '1h': '1 hora',
    '4h': '4 horas',
    today: 'Hoje',
    never: 'Não limpar',
  },
  clearsInMinutes: 'Some em {{minutes}} min',
  clearsInHours: 'Some em {{hours}} h',
  setStatus: 'Definir seu status (agora {{status}})',
  yourStatus: 'Seu status',
  setCustom: 'Definir um status personalizado',
  clearCustom: 'Limpar status personalizado',
  custom: {
    title: 'Status personalizado',
    clear: 'Limpar status',
    hint: 'Aparece ao lado do seu nome em todos os servidores em que você está.',
    label: 'O que está rolando?',
    changeEmoji: 'Emoji {{emoji}}, mudar',
    pickEmoji: 'Escolher um emoji',
    placeholder: 'ex.: Saí para almoçar',
    clearInput: 'Limpar texto e emoji',
    clearAfter: 'Limpar depois de',
  },
  errors: {
    singleEmoji: 'Escolha um único emoji.',
    tooLong: 'Os status personalizados podem ter até {{max}} caracteres.',
  },
  activity: {
    playing: 'Jogando <b>{{name}}</b>',
    playingTitle: 'Jogando {{name}}',
    justStarted: 'começou agora',
    minutes: '{{minutes}} min',
    hours: '{{hours}} h',
    hoursMinutes: '{{hours}} h {{minutes}} min',
  },
}
