// Русский. Same keys as ./en; the compiler flags anything missing or extra.
import type { DesktopText } from './en'

export const text: DesktopText = {
  tray: {
    open: 'Открыть Iskra',
    about: 'Об Iskra',
    check: 'Проверить обновления',
    checking: 'Проверка обновлений…',
    downloading: (version) => `Скачивается ${version}…`,
    restart: (version) => `Перезапустить и обновить до ${version}`,
    download: (version) => `Скачать Iskra ${version}`,
    quit: 'Выйти из Iskra',
  },
  updates: {
    titleReady: 'Обновление готово',
    titleAvailable: 'Доступно обновление',
  },
  menu: { view: 'Вид' },
  recordings: {
    pickTitle: 'Куда сохранять записи звонков?',
  },
  backup: {
    pickTitle: 'Восстановить сервер из резервной копии',
    filter: 'Резервные копии Iskra',
    notBackup: 'Этот файл — не резервная копия Iskra.',
  },
  bots: {
    pickTitle: 'Выберите бота, которому доверяете',
    pickMessage: 'Запускайте только тех ботов, которым доверяете: бот работает на этом компьютере с вашими правами и может читать и изменять ваши файлы.',
    pickButton: 'Выбрать эту папку',
    warnTitle: 'Запускайте только тех ботов, которым доверяете',
    runQuestion: (name) => `Запустить бота «${name}» на этом компьютере?`,
    autostartQuestion: (name) => `Запускать бота «${name}» при каждом запуске Iskra?`,
    changedQuestion: (name) => `Бот «${name}» изменился с прошлого запуска. Всё равно запустить?`,
    warnDetail: (folder) => `${folder}

Этот бот работает на этом компьютере с вашими правами: он может читать и изменять ваши файлы. Запускайте только тех ботов, которым доверяете.`,
    run: 'Запустить',
    autostart: 'Запускать вместе с Iskra',
    cancel: 'Отмена',
  },
  template: {
    pickTitle: 'Создать сервер из файла шаблона',
    filter: 'Шаблоны Iskra',
    tooBig: 'Этот файл слишком большой для шаблона.',
  },
  host: {
    defaultName: 'Мой сервер',
    noServer: 'В этой сборке нет сервера.',
    stoppedEarly: 'Сервер остановился сразу после запуска. Возможно, его порт занят?',
    damaged: 'Файлы сервера повреждены, поэтому он не запускается. Причина записана в server.log в его папке; поможет восстановление из резервной копии.',
    couldntStart: (error) => `Не удалось запустить сервер: ${error}`,
    couldntRun: (error) => `Сервер перестал работать: ${error}`,
    restoreFailed: 'Не удалось восстановить резервную копию.',
    noPort: 'Не найдено свободного порта.',
  },
  keys: {
    mouse: (button) => `Мышь ${button}`,
    key: (code) => `Клавиша ${code}`,
  },
  passkey: {
    title: 'Ключ доступа Iskra',
    waiting: 'Следуйте подсказке на устройстве или ключе безопасности.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Запуск Iskra…',
    servers: 'Запуск ваших серверов…',
    connecting: 'Подключение…',
    ready: 'Готово',
    updatedTo: (version) => `Обновлено до ${version}`,
    updating: (version) => `Обновление Iskra до ${version}…`,
    updatingDetail: 'Приложение вернётся через несколько секунд.',
  },
  assistant: {
    title: 'Ассистент Iskra',
    question: (host) => `Разрешить ассистенту отправлять ваши вопросы на ${host}?`,
    detail: 'Соглашайтесь, только если вы сами ввели этот адрес в разделе «Мои настройки» → «Ассистент». Туда будет отправляться то, что вы спрашиваете у ассистента, и то, что он для вас читает.',
    yes: 'Да, использовать',
    no: 'Нет',
  },
  digitalOcean: {
    done: 'DigitalOcean подключён. Можно закрыть эту вкладку и вернуться в Iskra.',
    denied: 'Подключить Iskra к DigitalOcean не удалось. Можно закрыть эту вкладку и вернуться в Iskra.',
  },
}
