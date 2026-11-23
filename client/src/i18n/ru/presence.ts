import type { Messages } from '../types'

export const presence: Messages['presence'] = {
  status: {
    online: 'В сети',
    idle: 'Нет на месте',
    dnd: 'Не беспокоить',
    invisible: 'Невидимка',
    offline: 'Не в сети',
  },
  hints: {
    idle: 'Включается и само, когда вы отходите',
    dnd: 'Без звуков и уведомлений, включая push',
    invisible: 'Для других вы не в сети, но Iskra работает как обычно',
  },
  clearAfter: {
    '30m': '30 минут',
    '1h': '1 час',
    '4h': '4 часа',
    today: 'Сегодня',
    never: 'Не сбрасывать',
  },
  clearsInMinutes: 'Сбросится через {{minutes}} мин',
  clearsInHours: 'Сбросится через {{hours}} ч',
  setStatus: 'Выбрать статус (сейчас: {{status}})',
  yourStatus: 'Ваш статус',
  setCustom: 'Задать свой статус',
  clearCustom: 'Сбросить свой статус',
  custom: {
    title: 'Свой статус',
    clear: 'Сбросить статус',
    hint: 'Виден рядом с вашим именем на всех ваших серверах.',
    label: 'Что происходит?',
    changeEmoji: 'Эмодзи {{emoji}}, изменить',
    pickEmoji: 'Выбрать эмодзи',
    placeholder: 'Например: обедаю',
    clearInput: 'Очистить текст и эмодзи',
    clearAfter: 'Сбросить через',
  },
  errors: {
    singleEmoji: 'Выберите один эмодзи.',
    tooLong: 'Свой статус может быть не длиннее {{max}} символов.',
  },
  activity: {
    playing: 'Играет в <b>{{name}}</b>',
    playingTitle: 'Играет в {{name}}',
    justStarted: 'только что',
    minutes: '{{minutes}} мин',
    hours: '{{hours}} ч',
    hoursMinutes: '{{hours}} ч {{minutes}} мин',
  },
}
