# Glosario: español (`es`)

One word per thing in the Spanish texts: the catalog (`client/src/i18n/es/`), the desktop app
(`desktop/src/text/es.ts`), the push texts (`client/public/push-text/es.js`) and the activities. Same sections and
terms as [`docs/i18n-glossary.md`](../i18n-glossary.md); rules in [translating.md](../translating.md).

## Decisions for the whole language

- **Variety.** Neutral Latin American Spanish that also reads naturally in Spain. No regional slang, no "vosotros".
  Where the regions differ, the word understood in both wins, and otherwise the Latin American one:
  "computadora" (not "ordenador"), "teléfono" (not "móvil"/"celular"), "archivo" (not "fichero"), "enlace" (not
  "link"), "altavoz" (not "parlante"/"bocina"), "auriculares" (not "audífonos"/"cascos"), "ícono" (with accent),
  "video" (no accent), "mouse" (not "ratón"), "presionar" a key (not "pulsar"), "tocar" on a phone, "hacer clic"
  with a mouse, "app" (feminine: "la app").
- **Form of address.** Informal "tú" for the reader ("Elige un nombre", "tus mensajes"). Plural you is "ustedes"
  ("Solo ustedes dos pueden leer estos mensajes"). Never "usted", "vos" or "vosotros".
- **Buttons, menu items, tabs, titles of actions:** infinitive ("Guardar", "Invitar amigos", "Crear canal…").
  Instructions and hints to the reader: imperative in "tú" ("Pega tu clave", "Vuelve a intentarlo").
- **Gender.** No wording that assumes the reader's or another person's gender. Reword instead of "bienvenido",
  "conectado", "invitado/a", "¿Estás seguro?": "Te damos la bienvenida", "en línea", "Te invitaron a…",
  "¿Seguro que quieres…?". With `{{name}}`: "{{name}} se unió", "{{name}} está hablando", never a participle or
  adjective that agrees with the person ("{{name}} fue expulsado" → "Se expulsó a {{name}}"). Role names and
  generic plurals stay in the usual generic form ("Propietario", "Miembros", "amigos", "Invitado" as a role).
- **Case.** Sentence case everywhere: only the first word and proper names are capitalised ("Mis ajustes",
  "Invitar amigos"). Lower case after a colon. Days, months and languages in lower case.
- **Typography.** Opening marks always: "¿…?", "¡…!". Quotation marks: “…” (not «…», not "…"); inside code they are
  the characters U+201C and U+201D. The ellipsis is one character (…). No space before "%" in the interface
  ("{{percent}}%"). No dash for an aside: use a colon, a comma or parentheses, as English does. Numbers: no thousands
  separator in four digits ("1440"). Units and short forms as in English: "min", "h", "s", "MB".
- **Past tense.** Simple past for what just happened ("Se copió", "{{name}} se unió"), natural in both regions.
- **Tone.** Plain and warm, short sentences. "No se pudo…" for a failure, then what to do. No "por favor" on every
  line, no exclamation marks that English doesn't have.
- **Not translated.** Iskra, brand names, AutoMod, LFG as a tag, AFK, webhook, bot, emoji, sticker, GIF, clip,
  slash commands, key names (Ctrl, Esc, Enter), file names and formats.

## People and places

| English | Español | Notes |
|---|---|---|
| Name | Nombre | "Tu nombre" |
| Server nickname | Apodo en el servidor ("Apodo en {{server}}" when the server is named) | Reset: "Usar mi nombre" |
| Owner, Admin, Moderator, Trusted, Member, Guest | Propietario, Admin, Moderador, De confianza, Miembro, Invitado | Roles. Plural: propietarios, admins, moderadores, de confianza, miembros, invitados |
| Role | Rol | Never "nivel" or "rango" |
| Built-in role (badge "Built-in") | Rol integrado (badge "Integrado") | Custom roles: "roles personalizados" |
| Permission | Permiso | Never "derecho" or "privilegio" |
| Bot, bots | Bot, bots | |
| Server | Servidor | |
| Channel, text channel, voice channel | Canal, canal de texto, canal de voz | Never "sala" for a voice channel |
| Stage | Escenario | |
| Thread | Hilo | |
| Forum post | Publicación | Forum: "foro". Never "post" |
| Direct message(s) | Mensaje(s) directo(s) | "MD" only as a short tab label |
| Group chat | Chat de grupo | Never "MD de grupo" |
| Device | Dispositivo | |
| Account | Cuenta | |

## Settings

| English | Español | Notes |
|---|---|---|
| My settings | Mis ajustes | Settings: "ajustes", never "configuración" or "preferencias" |
| Language (section) | Idioma | |
| Server settings | Ajustes del servidor | |
| Server, Members & safety, Apps, Hosting & data (groups) | Servidor, Miembros y seguridad, Apps, Alojamiento y datos | |
| Overview | Vista general | |
| Server icon, banner | Ícono del servidor, banner | |
| Channels | Canales | |
| Emoji & stickers | Emojis y stickers | |
| GIFs | GIFs | |
| Soundboard | Panel de sonidos | |
| Profile pages | Páginas de perfil | |
| Server rules | Reglas del servidor | |
| Members | Miembros | |
| Roles | Roles | |
| Reports | Reportes | |
| AutoMod (nav and heading) | AutoMod | |
| Audit log | Registro de auditoría | Never "registro de actividad" |
| Sign-ins & security | Sesiones y seguridad | Short for the nav; a sign-in is "inicio de sesión" |
| Bots & webhooks | Bots y webhooks | |
| Internet access (section) / Open to the internet (its switch) | Acceso desde internet / Abrir a internet | "internet" in lower case |
| Limits | Límites | |
| Backup & move | Copias y traslado | Short for the nav; a backup is still "copia de seguridad" |
| Import from Discord | Importar desde Discord | |
| Server updates | Actualizaciones | "Actualizaciones del servidor" in running text |
| Notifications | Notificaciones | |
| Recovery key | Clave de recuperación | |
| App lock | Bloqueo de la app | |

## Actions

| English | Español | Notes |
|---|---|---|
| Invite friends | Invitar amigos | |
| Invite link | Enlace de invitación | Invite (noun): "invitación" |
| Hide server (only off your list) | Ocultar servidor | Show again: "Volver a mostrar" |
| Leave server (really leaves) | Salir del servidor | Leave voice / a call: "Salir de la voz", "Salir de la llamada" |
| Sign out | Cerrar sesión | Sign in: "Iniciar sesión" |
| Kick | Expulsar | Noun: "expulsión" |
| Ban, unban | Banear, quitar el baneo | Noun: "baneo". The established word in chat apps; "bloquear" is Block |
| Time out / timeout | Suspender / suspensión | "Suspender 10 min", "Quitar la suspensión". Never "aislar" |
| Slowmode | Modo lento | |
| Mute (yourself) / Deafen | Silenciar micrófono / Desactivar audio | Undo: "Activar micrófono" / "Activar audio". States: "micrófono silenciado" (short: "en silencio"), "audio desactivado" (short: "sin audio") |
| Mute (someone else, for you) / Server mute | Silenciar / Silenciar en el servidor | "Silenciar para mí". Mute a channel or server (notifications): also "Silenciar" |
| Push to talk | Presionar para hablar | |
| Pin, unpin | Fijar, desfijar | "Mensajes fijados" |
| Report (noun) | Reporte | Verb: "reportar" |
| Upload | Subir | Download: "Descargar" |
| Preview | Vista previa | Also for the button |
| Delete / Remove | Eliminar / Quitar | "Eliminar" destroys; "Quitar" takes off a list. Never "borrar" (except Clear: "Borrar" a field, "Vaciar") |
| Optional | Opcional | |
| e.g. (example placeholders) | p. ej. ("p. ej. noche-de-juegos") | |

## Features

| English | Español | Notes |
|---|---|---|
| Mention | Mención (verb: mencionar) | |
| Poll | Encuesta | Vote: "voto", "votar" |
| Teams (team splitter; one team, "Team 1") | Equipos (reparto en equipos; un equipo, "Equipo 1") | |
| Looking for group (LFG post) | Busco grupo ("publicación LFG" only where short) | Tag stays "LFG" |
| Event | Evento | |
| Sticker | Sticker | Plural "stickers" |
| Emoji | Emoji | Plural "emojis" |
| Watch party | Ver juntos (as a name, also in running text: "en Ver juntos") | |
| Clip | Clip | Plural "clips" |
| Catch up | Ponerse al día (button: "Ponte al día") | |
| Passkey | Llave de acceso | Never "clave de acceso" (too close to the recovery key) |
| Passphrase | Frase de contraseña | Password: "contraseña" |
| End-to-end encrypted | Cifrado de extremo a extremo | Adjective agrees: "mensajes cifrados de extremo a extremo". Never "encriptado" |
| Decrypt | Descifrar | Encrypt: "cifrar" |
| Backup | Copia de seguridad | Verb: "hacer una copia de seguridad". Never "respaldo" or "backup" |

## Terms decided for Spanish

| English | Español | Notes |
|---|---|---|
| Friend, friends | Amigo, amigos | Friend request: "solicitud de amistad". Add friend: "Agregar a amigos" |
| Block, blocked people | Bloquear, personas bloqueadas | Unblock: "Desbloquear" |
| Ignore | Ignorar | |
| Message request | Solicitud de mensaje | |
| Online, Idle, Do not disturb, Invisible, Offline | En línea, Ausente, No molestar, Invisible, Sin conexión | Status: "estado"; custom status: "estado personalizado" |
| Unread | Sin leer | Mark as read: "Marcar como leído" |
| Reply | Responder (noun: respuesta) | |
| Reaction, react | Reacción, reaccionar | |
| Edit | Editar | "(editado)" on a message |
| Attachment | Archivo adjunto | Short: "adjunto" |
| File, folder | Archivo, carpeta | Server folder in the rail: "carpeta" |
| Category | Categoría | |
| Spoiler | Spoiler | |
| Link, link preview | Enlace, vista previa del enlace | |
| Search | Buscar (noun: búsqueda) | |
| Inbox | Bandeja de entrada | Bug inbox: "Buzón de errores" |
| Saved messages, bookmark | Mensajes guardados, guardar | |
| Reminder, remind me | Recordatorio, recordarme | |
| Scheduled message, schedule | Mensaje programado, programar | |
| Draft | Borrador | |
| Disappearing messages | Mensajes temporales | |
| Alert words | Palabras de alerta | |
| Follow (a person, a thread) | Seguir | |
| Quiet hours | Horas de silencio | Digest: "resumen" |
| Voice, in voice | Voz, en voz | "Unirse a la voz", "Conectado a voz" → "Voz conectada" |
| Call, group call | Llamada, llamada grupal | Hang up: "Colgar". Calling: "Llamando…" |
| Microphone, speaker, earpiece, headphones | Micrófono, altavoz, auricular, auriculares | |
| Camera | Cámara | |
| Screen share | Compartir pantalla | Noun: "pantalla compartida" |
| Noise suppression, echo cancellation | Supresión de ruido, cancelación de eco | |
| Captions, transcript | Subtítulos, transcripción | |
| Recording, record | Grabación, grabar | |
| Whisper, priority speaker | Susurro (verb: susurrar), orador prioritario | |
| Speaker, audience, raise hand (stage) | Orador, público, levantar la mano | Listener: "oyente" |
| AFK channel | Canal AFK | |
| Lobby, room, host (join-to-create rooms) | Lobby, sala, anfitrión | "Sala" only for these rooms. Host as a role in a room: reword where gender shows ("{{name}} dirige esta sala") |
| Activities, Together | Actividades, Juntos | Draw & guess: "Dibuja y adivina". Quiz/trivia: "Trivia" |
| Whiteboard | Pizarra | |
| Docs (channel kind), document | Documentos, documento | |
| Media (channel kind) | Multimedia | |
| Feed (RSS and the like) | Fuente | "Fuentes" |
| Template | Plantilla | |
| Theme, appearance | Tema, apariencia | |
| Streamer mode | Modo streamer | |
| Keybind, shortcut | Atajo de teclado | Short: "atajo" |
| Desktop app, tray | App de escritorio, bandeja del sistema | |
| Computer, phone, browser | Computadora, teléfono, navegador | |
| Home Screen (phone) | Pantalla de inicio | |
| Host, hosting (a server) | Alojar, alojamiento | "Create a server": "Crear un servidor" |
| Rent a server | Alquilar un servidor | Droplet, DigitalOcean: unchanged |
| Claim (a rented or 1-Click server), claim code | Reclamar, código de reclamación | |
| Backup buddy, pairing code | Compañero de copias, código de emparejamiento | |
| Recovery code | Código de recuperación | Not the account's "clave de recuperación" |
| Safety number, verify | Número de seguridad, verificar | |
| Link a device | Vincular un dispositivo | |
| Join (a server, a call) | Unirse ("Unirme" where the button speaks for the reader) | "Join a server": "Unirse a un servidor" |
| Join questions | Preguntas de ingreso | |
| Warn, note, history (moderation) | Advertir (noun: advertencia), nota, historial | |
| Assistant | Asistente | |
| Translation, translate | Traducción, traducir | |
| Bug report | Informe de error | "Reportar un error" as the action |
| Update, restart, quit | Actualización, reiniciar, salir | "Salir de Iskra" |
| Sandbox | Entorno aislado | |
| Tunnel, relay | Túnel, repetidor | |
| Limit, rate limit | Límite | "Vas muy rápido. Espera un momento." |
| Try again / Retry | Volver a intentar / Reintentar | In a sentence: "Vuelve a intentarlo." |
| Couldn't … | No se pudo … | |
| Something went wrong | Algo salió mal | |
| Welcome / Welcome back | Te damos la bienvenida / ¡Hola de nuevo! | |
| Someone, nobody, everyone | Alguien, nadie, todos | |
| You (label next to your own name) | tú | |
| Email, password | Correo, contraseña | |
| Setup (of a server, a bot) | Configuración, configurar | Only for setting something up; settings are always "ajustes" |
| System Settings (macOS) | Configuración del Sistema | As macOS names it in Latin American Spanish |
| Tag (forum, media, the Tags bot) | Etiqueta | |
| Giveaway | Sorteo | Reroll: "volver a sortear" |
| Suggestion | Sugerencia | |
| Counting (bot), streak | Conteo, racha | |
| Starboard (bot) | Destacados | |
| Built-in bots: Dice, Polls, Reminders, Birthdays, Welcome, Feeds | Dados, Encuestas, Recordatorios, Cumpleaños, Bienvenida, Fuentes | |
| Four in a row | Cuatro en línea | |
| Quizmaster | (reworded) | "{{name}} dirige la trivia": no gendered noun |
| Staff (of a server) | El equipo del servidor | |
| Video call, voice call, voice message | Videollamada, llamada de voz, mensaje de voz | |
| Live (stage, stream, event) | En vivo (stage, stream); en curso (event) | |
| Hi-fi audio | Audio de alta fidelidad | |
| Read aloud | Leer en voz alta | |
| Lock (a post, a room) | Bloquear | Same verb as Block; the object makes it clear |
| Prompt (for an AI assistant) | Instrucción | |
| Checksum, build attestation | Suma de comprobación, atestación de compilación | |
| Key transparency, key log | Transparencia de claves, registro de claves | |
| Keychain (of the system) | Llavero | |

## Task boards

| English | Español | Notes |
|---|---|---|
| Task board (the channel kind "Tasks") | Tablero de tareas (channel kind: "Tareas") | Short: "tablero" |
| Task | Tarea | Feminine: what agrees with it is feminine ("Asignada a", "Creada por", "modificada") |
| To do / Doing / Done (the columns) | Por hacer / En curso / Hecho | Done tasks in running text: "tareas hechas" |
| Assign, assigned to, "Assign me" | Asignar, asignada a, "Asignarme" | The participle agrees with the task, never with the person. Unassign me: "Quitarme" |
| Label (on a task; a forum has tags) | Etiqueta | The same word as a forum's tag |
| Due (a task's due day) | Vence ("Vence el {{date}}", "Vence hoy"; passed: "Venció el {{date}}") | No due day: "Sin fecha" |
| Archive, archived (a done task put away) | Archivar, archivada | Put back: "Devolver al tablero" |
| Comment (on a task) | Comentario | Verb: "comentar" |

## Photos channels

| English | Español | Notes |
|---|---|---|
| Photos channel (the channel kind "Photos") | Canal de fotos (channel kind: "Fotos") |  |
| Photo, video | Foto, video | "Foto" is feminine: what agrees with the photos is feminine ("seleccionadas", "Agregadas por"). Sentences that can be about a photo or a video avoid agreement ("Se agregó el {{date}}") |
| Album / "No album" | Álbum / "Sin álbum" | Plural "álbumes". Audit log filter: "Álbumes de fotos" |
| Add photos | Agregar fotos | Never "subir" for the action; "Subiendo" only for the upload step |
| Date taken | Fecha de captura | "Se tomó el {{taken}}" |
| Caption | Descripción | The same word as in a media channel. "Subtítulos" is only for live captions |
| Storage / storage limit | Almacenamiento / límite de almacenamiento | "{{used}} de {{cap}} en uso". Raise the limit: "subir el límite" |
| Cover (album cover) | Portada | "Usar como portada del álbum" |
| Hidden data / metadata | Datos ocultos / metadatos | "Metadatos" only in the server error; the app says "datos ocultos" and names them (ubicación, datos de la cámara y del teléfono). Remove: "quitar" |
| Select | Seleccionar | "{{count}} seleccionadas", "Seleccionar todas" |
| Download album | Descargar álbum | All: "Descargar todo". The file: "el zip" |
| Thumbnail | Miniatura |  |

## Notes for whoever edits these texts

- **"You" inside a sentence.** Some texts get either a name or the word for "you" in `{{who}}` (group chat system
  lines: `groups.change.*`, `groups.namedGroup`, `groups.startedVideo`). A Spanish verb would have to agree
  ("Ana agregó" / "Tú agregaste"), so these lines have no verb that agrees with the person:
  "Ana · Miembros nuevos: Bo y tú", "Tú · Salida del grupo".
- **Bot commands.** The built-in bots only understand English (and Swedish) keywords and month names:
  `set`, `remove`, `list`, `end`, `cancel`, `reroll`, "14 March". The Spanish examples use what works:
  `/birthday set 14/3`, `/remind 10m sacar la pizza`, `/tag list`.
- **Names the server writes in English** and that the catalog can't change: the rooms made from a lobby
  ("alice's-room"), the "Bug reports" author of bug inbox messages.
- **Captions and transcripts** are English or Swedish only; the texts say so.
