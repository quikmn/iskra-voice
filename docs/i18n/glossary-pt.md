# Glossário: Português (Brasil)

Code `pt`, locale `pt-BR`. Same English terms and order as [`../i18n-glossary.md`](../i18n-glossary.md), then the
extra terms decided for Portuguese. Rules: [`../translating.md`](../translating.md).

## Rules for the whole language

- **Form of address:** "você", with the verb in the third person singular ("Você pode…", "Escolha um nome",
  "Tente de novo"). Possessives: "seu/sua". Never "tu", "vós", "o senhor/a senhora".
- **Tone:** plain and friendly, like popular Brazilian chat and gaming apps. Short sentences. "Não foi possível…"
  for "Couldn't…", followed by what the person can do.
- **Gender:** don't assume the person's gender. Avoid participles and adjectives that agree with the person
  ("Bem-vindo", "conectado", "obrigado", "sozinho"): use "Boas-vindas", "Você entrou como…", "Valeu", "só você".
  With a `{{name}}`, pick a wording without agreement ("{{name}} entrou", "{{name}} saiu da chamada", "{{name}} está
  com o microfone desativado"). Role names keep the standard dictionary form (Dono, Moderador, Convidado).
- **Case:** sentence case in headings, buttons and menu items ("Convidar amigos", "Minhas configurações"). Capitals
  only for the first word and proper names. No Title Case.
- **Buttons and menu items:** infinitive ("Salvar", "Convidar amigos", "Sair do servidor"). Instructions to the
  person: imperative of "você" ("Escolha", "Digite", "Tente").
- **Typography:** curly quotes “…”; `…` (U+2026) for ellipsis; no space before `?` `!` `:`. "ex.:" for "e.g.".
  Time units stay short: "min", "h", "s". Lists: "A, B e C" (no comma before "e").
- **Spelling:** Brazilian spelling after the 2009 reform ("ideia", "câmera", "arquivo", "tela", "celular", never
  "ecrã", "ficheiro", "telemóvel", "utilizador").
- **Loanwords kept**, as Brazilians use them: chat, bot, link, online, offline, backup, login, emoji, GIF, webhook,
  token, feed, tag, quiz, spam, streamer, upload (noun), post, lobby, banner, app, e-mail, site, AFK, LFG.
- "Iskra", product names (Discord, DigitalOcean, Tailscale, GitHub, Twitch), `AutoMod`, file formats, slash
  commands and key names (`Ctrl`, `Esc`, `Enter`) are never translated.
- **Plurals:** `_one` (used for 0 and 1) always contains `{{count}}`: "{{count}} membro" / "{{count}} membros".

## People and places

| English | Português | Notes |
|---|---|---|
| Name | Nome | Your Iskra name, everywhere unless a server nickname is set |
| Server nickname | Apelido no servidor ("Apelido em {{server}}" when the server is named) | Reset: "Usar meu nome" |
| Owner, Admin, Moderator, Trusted, Member, Guest | Dono, Admin, Moderador, Confiável, Membro, Convidado | Roles; lower case in running text; plural "admins" |
| Role | Cargo | As on Discord in Brazil. Never "função", "papel" or "nível" |
| Built-in role (badge "Built-in") | Cargo integrado (badge "Integrado") | Above the "cargos personalizados" (custom roles). Never "cargo base" |
| Permission | Permissão | Never "direito" or "poder" |
| Bot, bots | Bot, bots | |
| Server | Servidor | |
| Channel, text channel, voice channel | Canal, canal de texto, canal de voz | Never "sala" for a voice channel |
| Stage | Palco | |
| Thread | Tópico | As on Discord in Brazil |
| Forum post | Post | |
| Direct message(s) | Mensagem direta, mensagens diretas | "DMs" only as a short tab label, never in sentences |
| Group chat | Chat em grupo | Never "DM em grupo" |
| Device | Dispositivo | |
| Account | Conta | |

## Settings

| English | Português | Notes |
|---|---|---|
| My settings | Minhas configurações | "Configurações" for Settings everywhere, never "definições" or "ajustes" |
| Language (section) | Idioma | |
| Server settings | Configurações do servidor | |
| Server, Members & safety, Apps, Hosting & data (groups) | Servidor, Membros e segurança, Apps, Hospedagem e dados | "e" for "&" |
| Overview | Visão geral | |
| Server icon, banner | Ícone do servidor, banner | |
| Channels | Canais | |
| Emoji & stickers | Emojis e figurinhas | |
| GIFs | GIFs | |
| Soundboard | Mesa de som | |
| Profile pages | Páginas de perfil | |
| Server rules | Regras do servidor | |
| Members | Membros | |
| Roles | Cargos | |
| Reports | Denúncias | |
| AutoMod (nav and heading) | AutoMod | |
| Audit log (who changed what; never "activity log", which is games) | Registro de auditoria | |
| Sign-ins & security (never "security log" as a name) | Logins e segurança | |
| Bots & webhooks | Bots e webhooks | |
| Internet access (section) / Open to the internet (its switch) | Acesso pela internet / Abrir para a internet | |
| Limits | Limites | |
| Backup & move | Backup e mudança | |
| Import from Discord | Importar do Discord | |
| Server updates | Atualizações do servidor | |
| Notifications | Notificações | |
| Recovery key | Chave de recuperação | |
| App lock | Bloqueio do app | |

## Actions

| English | Português | Notes |
|---|---|---|
| Invite friends | Convidar amigos | |
| Invite link | Link de convite | |
| Hide server (only off your list) | Ocultar servidor | |
| Leave server (really leaves) | Sair do servidor | |
| Sign out | Sair da conta | Sign in: "Fazer login" (noun "login"). Never plain "Sair" for sign out: that is Leave |
| Kick | Expulsar | |
| Ban, unban | Banir, desbanir | Noun: banimento |
| Time out / timeout | Colocar de castigo / castigo | As on Discord in Brazil. "Tirar do castigo" to end it |
| Slowmode | Modo lento | |
| Mute (yourself) / Deafen | Desativar microfone / Desativar áudio | Back on: "Ativar microfone" / "Ativar áudio". States: "Microfone desativado", "Áudio desativado" |
| Mute (someone else, for you) / Server mute | Silenciar / Silenciar no servidor | Server deafen: "Desativar áudio no servidor". A muted channel or server (notifications) is also "silenciado" |
| Push to talk | Aperte para falar | |
| Pin, unpin | Fixar, desafixar | "Mensagens fixadas" |
| Report (noun) | Denúncia | Verb: denunciar |
| Upload | Fazer upload | Noun: upload. "Enviar" is Send only |
| Preview | Pré-visualizar | Noun: prévia |
| Delete / Remove | Excluir / Remover | Never "apagar" or "deletar" |
| Optional | Opcional | |
| e.g. (example placeholders: "e.g. game-night") | ex.: ("ex.: noite-de-jogos") | |

## Features

| English | Português | Notes |
|---|---|---|
| Mention | Menção (verb: mencionar) | |
| Poll | Enquete | |
| Teams (team splitter; one team, "Team 1") | Times (dividir em times; um time, "Time 1") | |
| Looking for group (LFG post) | Procurando grupo ("LFG" only where short) | |
| Event | Evento | |
| Sticker | Figurinha | |
| Emoji | Emoji, emojis | |
| Watch party | Assistir juntos (as a name, also in running text: "no Assistir juntos") | |
| Clip | Clipe | |
| Catch up | Ficar em dia | Its panel: "O que você perdeu" |
| Passkey | Chave de acesso | As Google and Apple call it in Brazil |
| Passphrase | Frase secreta | |
| End-to-end encrypted | Criptografado de ponta a ponta | Noun: criptografia de ponta a ponta |
| Decrypt | Descriptografar | Encrypt: criptografar |
| Backup | Backup | |

## More terms decided for Portuguese

| English | Português | Notes |
|---|---|---|
| Settings | Configurações | |
| Save / Cancel / Close / Done | Salvar / Cancelar / Fechar / Concluir | "Concluído" for the state |
| Edit / Create / Add | Editar / Criar / Adicionar | |
| Send | Enviar | |
| Download | Baixar | Noun: download |
| Copy / Copied | Copiar / Copiado | |
| Retry, Try again | Tentar de novo | |
| Join (a server, a call) / Leave | Entrar / Sair | |
| Search | Buscar | Noun: busca |
| Loading… | Carregando… | |
| On / Off | Ativado / Desativado | Switches: "Ativar", "Desativar" |
| Message | Mensagem | |
| Reply / Forward | Responder / Encaminhar | |
| Reaction | Reação | |
| Attachment / File / Folder | Anexo / Arquivo / Pasta | |
| Picture, image | Imagem | "Foto" for a profile picture |
| Friend / Friend request | Amigo / Pedido de amizade | |
| Message request | Pedido de mensagem | |
| Block / Blocked people | Bloquear / Pessoas bloqueadas | |
| Follow / Follows | Seguir / Seguindo | |
| Invite (noun) | Convite | |
| Category | Categoria | |
| Server folder | Pasta | |
| Forum / Tag | Fórum / Tag | |
| Media channel / Docs channel / page | Canal de mídia / Canal de documentos / página | |
| Call / Group call | Chamada / Chamada em grupo | "{{name}} está ligando"; Hang up: "Desligar" |
| Voice / in voice | Voz / em voz | "Sair da voz", "Voz conectada" |
| Camera / Microphone / Speaker | Câmera / Microfone / Alto-falante | Stage speaker (person): "Palestrante"; listener: "Ouvinte" |
| Screen share | Compartilhar tela (noun: compartilhamento de tela) | |
| Whisper | Sussurro (verb: sussurrar) | |
| Priority speaker | Voz prioritária | |
| AFK channel | Canal AFK | |
| Lobby / room (join-to-create) | Lobby / sala | Room host: "anfitrião" |
| Status: Online, Idle, Do not disturb, Invisible, Offline | Online, Ausente, Não perturbe, Invisível, Offline | |
| Custom status | Status personalizado | Custom (anything): personalizado |
| Activities | Atividades | |
| Draw & guess / Quiz / Four in a row | Desenhe e adivinhe / Quiz / Quatro em linha | |
| Whiteboard | Quadro branco | |
| Saved messages | Mensagens salvas | |
| Reminder / Remind me | Lembrete / Lembrar-me | |
| Scheduled message / Send later | Mensagem agendada / Enviar depois | |
| Inbox | Caixa de entrada | |
| Edit history | Histórico de edições | |
| Favourites | Favoritos | |
| Disappearing messages | Mensagens temporárias | As on WhatsApp in Brazil |
| Alert words / Alerts | Palavras de alerta / Alertas | |
| Quiet hours | Horário de silêncio | |
| Read aloud / Speech | Ler em voz alta / Fala | |
| Voice message / transcript | Mensagem de voz / transcrição | |
| Captions | Legendas | |
| Background (camera) | Plano de fundo | |
| Recording / record | Gravação / gravar | |
| Translation / translate | Tradução / traduzir | |
| Streamer mode | Modo streamer | |
| Pop out / picture-in-picture | Destacar (janela destacada) / picture-in-picture | |
| Keybinds / Keyboard shortcuts | Teclas de atalho / Atalhos de teclado | |
| Theme | Tema | |
| Assistant | Assistente | |
| Built-in bots | Bots integrados | |
| Incoming / outgoing webhook | Webhook de entrada / webhook de saída | |
| Signing secret / Token | Segredo de assinatura / Token | |
| Feed | Feed | |
| Template | Modelo | |
| Public page | Página pública | |
| Warning / warn | Advertência / advertir | |
| Moderator notes | Anotações de moderador | |
| Moderation history | Histórico de moderação | |
| Join questions | Perguntas de entrada | |
| Roles on join | Cargos ao entrar | |
| Join flood / Mention spam / Repeated messages | Enxurrada de entradas / Spam de menções / Mensagens repetidas | AutoMod rules |
| Blocked words / Exemptions | Palavras bloqueadas / Exceções | |
| Data retention | Retenção de dados | |
| Account key / Key history / Key log / Key transparency | Chave da conta / Histórico de chaves / Registro de chaves / Transparência de chaves | |
| Recovery code | Código de recuperação | |
| Password | Senha | |
| Host a server / hosting | Hospedar um servidor / hospedagem | |
| Rent a server | Alugar um servidor | |
| Claim a server / claim code | Resgatar um servidor / código de resgate | |
| Backup buddies | Parceiros de backup | |
| Port forwarding | Redirecionamento de portas | |
| Update / Restart | Atualização (atualizar) / Reiniciar | |
| Report a bug | Relatar um bug | |
| Desktop app / phone | App para computador / celular | "Computador", never "PC" except in "Bots neste PC" where short |
| Tap / Click | Tocar ("Toque") / Clicar ("Clique") | |
| Channel topic, stage topic | Assunto | "Tópico" is Thread only |
| Transfer ownership | Transferir posse | |
| Link a device | Vincular um dispositivo | Pairing code: código de pareamento |
| Safety number | Número de segurança | |
| Bug inbox / bug report (noun) | Caixa de bugs / relato de bug | |
| Screenshot | Captura de tela | |
| Invite label | Etiqueta | |
| Spot (backup buddy), slot (LFG) | Vaga | |
| Dismiss / Got it / Not now | Dispensar / Entendi / Agora não | |
| Everyone | Todo mundo | |
| Post (verb) | Postar | |
| Staff | Equipe | |
| Giveaway / Starboard / Counting | Sorteio / Mural de estrelas / Contagem | Built-in bots |
| Audience / raise hand / go live (stage) | Plateia / levantar a mão / entrar ao vivo | |
| Snooze / Schedule | Adiar / Agendar | |
| Tray | Bandeja | |
| Lock / close (forum post) | Trancar / fechar | |
| Former member | Ex-membro | |
| Appearance / Accent colour | Aparência / Cor de destaque | |
| Noise suppression / Voice activity | Supressão de ruído / Detecção de voz | |
| macOS System Settings | Ajustes do Sistema | As Apple writes it in pt-BR |

## Task boards

| English | Português | Notes |
|---|---|---|
| Task board (the channel kind "Tasks") | Quadro de tarefas (channel kind: "Tarefas") | "o quadro" in running text. Never "kanban" or "painel" |
| Task | Tarefa | Feminine: "atribuída", "arquivada", "criada por" |
| To do / Doing / Done (the columns) | A fazer / Fazendo / Concluído | Tasks in the last column: "tarefas concluídas" |
| Assign, assigned to, "Assign me" | Atribuir, atribuída a, "Atribuir a mim" | "{{name}} atribuiu uma tarefa a você". Unassign me: "Sair da tarefa" |
| Label (on a task; a forum has tags) | Etiqueta | "Tag" is for forums only |
| Due (a task's due day) | Prazo | "Prazo: {{date}}", "Vence hoje", "Venceu em {{date}}", "Sem prazo" |
| Archive, archived (a done task put away) | Arquivar, arquivada | Put back: "Devolver ao quadro" |
| Comment (on a task) | Comentário | Verb: comentar |
