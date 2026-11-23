# Глоссарий: русский (`ru`)

One word per thing in the Russian texts: the catalog (`client/src/i18n/ru/`), the desktop app
(`desktop/src/text/ru.ts`), the push texts (`client/public/push-text/ru.js`) and the activities. Format and rules:
[translating.md](../translating.md#glossary). English terms and their order follow [i18n-glossary.md](../i18n-glossary.md).

## Decisions for the whole language

### Form of address: «вы», lower case

The person is addressed as **«вы» with a small letter** («вы», «вам», «ваш»), everywhere.

Why:

- It is what the chat apps Russian speakers already use do: Discord, Telegram, VK and WhatsApp all write «вы» in
  lower case in their Russian interfaces, also for a young and casual audience. «Ты» in an interface reads as a
  children's product or as marketing; capital «Вы» reads as an official letter.
- «Вы» keeps texts free of the person's gender: «вы вышли», «вы уверены», «вы приглашены» fit everyone, where «ты»
  would need «вышел/вышла», «уверен/уверена».
- The tone stays friendly through short sentences and everyday words, not through «ты».

Never «ты», never capital «Вы»/«Ваш» (except at the start of a sentence).

### Verb forms

- Buttons, menu items, tabs and switches: the infinitive («Сохранить», «Пригласить друзей», «Покинуть сервер»).
- Instructions, hints and placeholders: the polite imperative («Выберите файл», «Введите имя»).
- Results and states: a short neutral form («Сохранено», «Скопировано», «Готово»), no «Вы сохранили».
- Errors: what happened and what to do next, without «Ошибка:» in front and without «пожалуйста» in every sentence.
  «Не удалось …» for "Couldn't …". «Нельзя …» / «Вы не можете …» for "You can't …".

### Names, numbers and gender

Values are inserted as they are: a name isn't declined and its gender isn't known.

- Keep `{{name}}` in the nominative: as the subject, or after a colon or dash.
- No past tense after a name (it would show gender: «присоединился/присоединилась»). In order of preference:
  1. present tense: «{{name}} звонит», «{{name}} печатает», «{{name}} приглашает вас»;
  2. a sentence about the thing, with the name after a colon or in brackets: «Сообщение закреплено: {{name}}»,
     «Автор: {{name}}»;
  3. «теперь», «уже», «больше не» with a present form or no verb: «{{name}} теперь в сети»,
     «{{name}} больше не на сервере», «{{name}} теперь с нами»;
  4. where nothing else reads well, a generic noun carries the verb: «Участник {{name}} вышел».
- Where a case is needed, a declined generic noun goes in front of the variable: «от пользователя {{name}}»,
  «в канале #{{channel}}», «на сервере {{server}}», «в игре {{game}}», «для роли {{role}}». A bare «от {{name}}» or
  «с {{name}}» only where the generic noun doesn't fit the space.
- Nothing about the reader shows gender either: «вы уверены», «вы приглашены» (plural forms), never «готов/готова»,
  «должен/должна» (use «нужно», «можно», «вам стоит»).
- Plurals: `_one` «{{count}} сообщение» (1, 21, 31: always with `{{count}}`), `_few` «{{count}} сообщения» (2–4),
  `_many` «{{count}} сообщений» (0, 5–20), `_other` «{{count}} сообщения» (fractions: genitive singular, the same
  as `_few` in nearly every case). Adjectives and participles follow the number too: «{{count}} новое сообщение»,
  «{{count}} новых сообщения», «{{count}} новых сообщений». A verb before the number takes the neutral form where
  that avoids four different verbs («Выбрано: {{count}}»); the colon form «Участников: {{count}}» is fine where a
  sentence would be awkward, but each plural key still has all four forms.

### Capitalisation

Sentence case: the first word and proper names only («Настройки сервера», «Пригласить друзей»). Names of settings
sections, features and roles are lower case in running text («в настройках сервера», «роль модератора») and get «…»
when a button or section is referred to by its name («откройте «Мои настройки»»). Days and months are lower case.

### Typography

- Quotation marks: «ёлочки»; inside them „лапки“. Never straight `"` or English “ ”.
- Dash: a long dash with spaces ( — ) between parts of a sentence; a hyphen inside words («кто-то», «тайм-аут»);
  an en dash without spaces for ranges (2–4).
- **ё** is always written: «всё», «ещё», «её», «включён», «учётная», «шёпот», «чёрный».
- `…` is one character. No space before `?`, `!`, `:`, `;`.
- Numbers: a comma for decimals, a non-breaking space only where the code already formats the number.
  Units after a space: «5 МБ», «10 мин», «30 с», «2 ч», «3 дн.». «№» is not used for channels; channels keep `#`.
- No full stop at the end of buttons, labels, titles and placeholders; a full stop at the end of a full sentence.
- Abbreviations that are normal in Russian are fine in tight places: «мин», «ч», «с», «ЛС». Otherwise write words out.

### Not translated

«Iskra» (always in Latin letters, never «Искра»), brand and product names (Discord, DigitalOcean, Tailscale, GitHub,
LiveKit, Windows), `AutoMod`, file formats (PNG, GIF, ZIP), slash commands (`/roll`), key names (`Ctrl`, `Esc`,
`Shift`, `Enter`), code, URLs.

## People and places

| English | Русский | Notes |
|---|---|---|
| Name | Имя | Your Iskra name. Never «ник» for this |
| Server nickname | Ник на сервере («Ник на сервере {{server}}» when the server is named) | Reset: "Use my name" → «Использовать моё имя» |
| Owner, Admin, Moderator, Trusted, Member, Guest | Владелец, Администратор, Модератор, Доверенный, Участник, Гость | Roles. «Админ» where space is tight and in casual running text («админы сервера»). Lower case in running text and in `common.roles` |
| Role | Роль | Never «уровень» |
| Built-in role (badge "Built-in") | Встроенная роль (badge «Встроенная») | Custom roles: «свои роли» |
| Permission | Право (pl. права) | What a role allows: «права роли», «нет прав». A browser or system permission (microphone, notifications) is «разрешение» |
| Bot, bots | Бот, боты | |
| Server | Сервер | |
| Channel, text channel, voice channel | Канал, текстовый канал, голосовой канал | Never «комната» for a voice channel |
| Stage | Трибуна | As in Discord. Speaker: «спикер»; audience: «слушатели» |
| Thread | Ветка | As in Discord |
| Forum post | Публикация | In a forum channel. A feed or bot "post" is «запись»; «пост» is not used |
| Direct message(s) | Личное сообщение, личные сообщения | «ЛС» only as a short tab label |
| Group chat | Групповой чат | |
| Device | Устройство | |
| Account | Аккаунт | Not «учётная запись» |

## Settings

| English | Русский | Notes |
|---|---|---|
| My settings | Мои настройки | |
| Language (section) | Язык | |
| Server settings | Настройки сервера | |
| Server, Members & safety, Apps, Hosting & data (groups) | Сервер, Участники и безопасность, Приложения, Хостинг и данные | |
| Overview | Обзор | |
| Server icon, banner | Значок сервера, баннер | |
| Channels | Каналы | |
| Emoji & stickers | Эмодзи и стикеры | |
| GIFs | GIF | Indeclinable: «свои GIF», «поиск GIF» |
| Soundboard | Звуковая панель | A sound on it: «звук» |
| Profile pages | Страницы профиля | |
| Server rules | Правила сервера | |
| Members | Участники | |
| Roles | Роли | |
| Reports | Жалобы | |
| AutoMod (nav and heading) | AutoMod | |
| Audit log | Журнал аудита | Never «журнал активности» |
| Sign-ins & security | Входы и безопасность | |
| Bots & webhooks | Боты и вебхуки | |
| Internet access (section) / Open to the internet (its switch) | Доступ из интернета / Открыть для интернета | |
| Limits | Лимиты | |
| Backup & move | Резервная копия и переезд | |
| Import from Discord | Импорт из Discord | |
| Server updates | Обновления сервера | |
| Notifications | Уведомления | |
| Recovery key | Ключ восстановления | |
| App lock | Блокировка приложения | |

## Actions

| English | Русский | Notes |
|---|---|---|
| Invite friends | Пригласить друзей | |
| Invite link | Ссылка-приглашение | An invite: «приглашение» |
| Hide server (only off your list) | Скрыть сервер | |
| Leave server (really leaves) | Покинуть сервер | |
| Sign out | Выйти из аккаунта | «Выйти» alone where the context is clear. Sign in: «Войти» |
| Kick | Выгнать | As in Discord |
| Ban, unban | Забанить, разбанить | Noun: «бан». As in Discord |
| Time out / timeout | Отправить в тайм-аут / тайм-аут | Remove: «Снять тайм-аут» |
| Slowmode | Медленный режим | |
| Mute (yourself) / Deafen | Выключить микрофон / Выключить звук | Undo: «Включить микрофон», «Включить звук» |
| Mute (someone else, for you) / Server mute | Заглушить / Заглушить на сервере | Undo: «Вернуть звук». Server deafen: «Отключить звук на сервере». Muting a channel or server (notifications): «Отключить уведомления» |
| Push to talk | Режим рации | As in Discord. Voice activity: «Активация голосом» |
| Pin, unpin | Закрепить, открепить | |
| Report (noun) | Жалоба | Verb: «пожаловаться». A bug report is «сообщение об ошибке» |
| Upload | Загрузить | Download: «Скачать» |
| Preview | Предпросмотр | |
| Delete / Remove | Удалить / Убрать | «Удалить»: it is gone. «Убрать»: taken off a list or out of a place |
| Optional | Необязательно | |
| e.g. (example placeholders) | Например: … («Например: вечер-игр») | |

## Features

| English | Русский | Notes |
|---|---|---|
| Mention | Упоминание (verb: упомянуть) | |
| Poll | Опрос | |
| Teams (team splitter; one team, "Team 1") | Команды (разделение на команды; «Команда 1») | |
| Looking for group (LFG post) | Поиск игроков (the post: «объявление») | Never «LFG» in visible text except the `/lfg` command |
| Event | Событие | |
| Sticker | Стикер | |
| Emoji | Эмодзи | Indeclinable, neuter |
| Watch party | Совместный просмотр | |
| Clip | Клип | |
| Catch up | Пропущенное | "What's new" (after an update) is «Что нового» |
| Passkey | Ключ доступа | The term Apple, Google and Windows use in Russian |
| Passphrase | Кодовая фраза | |
| End-to-end encrypted | Со сквозным шифрованием | Noun: «сквозное шифрование» |
| Decrypt | Расшифровать | |
| Backup | Резервная копия | Verb: «сделать резервную копию». Restore: «восстановить» |

## More terms (decided for Russian)

| English | Русский | Notes |
|---|---|---|
| Message | Сообщение | |
| Reply (noun, verb) | Ответ, ответить | |
| Reaction | Реакция | |
| Attachment | Вложение | |
| Link | Ссылка | |
| Invite (noun) | Приглашение | |
| Friend, friend request | Друг, заявка в друзья | «Добавить в друзья», «Удалить из друзей» |
| Message request | Запрос на переписку | |
| Block, unblock | Заблокировать, разблокировать | |
| Ignore | Игнорировать | |
| Online, Idle, Do not disturb, Invisible, Offline | В сети, Нет на месте, Не беспокоить, Невидимка, Не в сети | «Нет на месте» shows no gender |
| Status, custom status | Статус, свой статус | |
| Activity (presence: "Playing …") | Активность («Играет в …») | |
| Activities (games in a call) | Активности | One: «активность» |
| Call, group call | Звонок, групповой звонок | Verb: «позвонить». Join a call: «присоединиться» |
| Voice (short for the voice channel or call) | Голосовой канал; «в голосовом канале» | No bare «войс» |
| Screen share | Демонстрация экрана | Verb: «показать экран». Stop: «остановить показ» |
| Camera, microphone, speakers, headphones | Камера, микрофон, динамики, наушники | Input/output device: «устройство ввода/вывода» |
| Noise suppression | Шумоподавление | |
| Whisper | Шёпот | |
| Priority speaker | Приоритетный спикер | |
| Recording | Запись | «Записать звонок», «Идёт запись» |
| Live captions | Субтитры | |
| Whiteboard | Доска | |
| Category | Категория | |
| Forum (channel) | Форум | |
| Media channel | Медиаканал | |
| Docs channel, document | Канал с документами, документ | |
| Lobby / room (join-to-create) | Лобби / комната | The only place «комната» is used |
| AFK channel | AFK-канал | |
| Unread | Непрочитанные | |
| Inbox | Входящие | |
| Draft | Черновик | |
| Saved messages | Сохранённые сообщения | As a sidebar entry and tab: «Сохранённое» |
| Reminder | Напоминание | |
| Scheduled message | Отложенное сообщение | |
| Edit history | История изменений | Edited: «изменено» |
| Disappearing messages | Исчезающие сообщения | |
| Spoiler | Спойлер | |
| Quiet hours | Тихие часы | |
| Alert word, keyword alert | Ключевое слово, оповещение по ключевым словам | |
| Follow (a person or post) | Подписаться; «вы подписаны» | |
| Feed (the Feeds bot) | Лента | |
| Webhook, incoming, outgoing | Вебхук, входящий, исходящий | |
| Token, secret | Токен, секрет | |
| Warn, warning (moderation) | Предупредить, предупреждение | |
| Note (moderation) | Заметка | |
| Join question | Вопрос при входе | |
| Rules | Правила | |
| Terms | Условия | |
| Template | Шаблон | |
| Streamer mode | Режим стримера | |
| Favourite (channel) | Избранное; «в избранном» | |
| Assistant | Ассистент | |
| Translate, translation | Перевести, перевод | |
| Read aloud | Прочитать вслух | |
| Voice message, transcript | Голосовое сообщение, расшифровка | |
| Notification sound | Звук уведомления | |
| Keybind | Горячая клавиша | |
| Pop-out, picture-in-picture | Отдельное окно, картинка в картинке | |
| Self-hosted / host a server | На своём сервере / держать сервер у себя | |
| Hosting | Хостинг | |
| Rent a server | Арендовать сервер | |
| Port forwarding | Проброс портов | |
| Claim (a server), claim code | Стать владельцем, код владельца | |
| Backup buddy | Напарник (по резервным копиям) | |
| Update (noun) | Обновление | |
| Tray | Трей | |
| Desktop app, phone app | Приложение для компьютера, приложение для телефона | |
| Browser | Браузер | |
| Sign in, sign-in | Войти, вход | |
| Password | Пароль | |
| Security log | Журнал безопасности | Only as a description; the section is «Входы и безопасность» |
| Data retention | Хранение данных | |
| Export | Экспорт; «экспортировать» | |
| Bug report | Сообщение об ошибке; «Сообщить об ошибке» | |
| Trivia / quiz | Викторина | |
| Draw & guess | Рисуй и угадывай | A name, in «…» in running text |
| Settings | Настройки | |
| Cancel / Save / Close / Done / Back / Next | Отмена / Сохранить / Закрыть / Готово / Назад / Далее | |
| Couldn't … | Не удалось … | |
| Try again | Попробовать ещё раз | Hint: «Попробуйте ещё раз» |
| Someone | Кто-то | |
| Everyone (@everyone) | Все | The mention itself stays `@everyone` |
| Profile picture, server picture (of a member) | Аватар, аватар на сервере | Other images: «картинка»; "image" as a file type: «изображение» |
| Transfer ownership | Передать владение | |
| Host (watch party, activity) / room host | Ведущий / хозяин комнаты | Never «хост» |
| Safety number | Код безопасности | |
| Link a device | Привязать устройство | |
| Account key, security key | Ключ аккаунта, ключ безопасности | |
| Pairing code, recovery code | Код привязки, код восстановления | |
| Tag | Тег | |
| Giveaway, suggestion | Розыгрыш, предложение | |
| Docs page, sub-page, "Start here" | Страница, вложенная страница, «Начните здесь» | |
| Channel topic | Тема канала | |
| Screenshot | Снимок экрана | «Скриншоты» as a kind of content in a media channel |
| Server staff | Администрация сервера | A bot's staff role: «роль персонала» |
| Live (stage) / live (event) | В эфире / идёт сейчас | |
| Appearance, Voice & audio, Blocked people, Privacy & data, About & legal | Оформление, Голос и звук, Заблокированные, Приватность и данные, О приложении | My settings sections |
| Router, firewall | Роутер, брандмауэр | |
| Dismiss / Got it | Скрыть / Понятно | |
| AI | ИИ | |
| Iskra (grammar) | Feminine agreement: «Iskra заблокирована» | |
