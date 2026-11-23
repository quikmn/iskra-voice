import type { Messages } from '../types'

export const sounds: Messages['sounds'] = {
  heading: 'Töne',
  names: {
    classic: 'Klassisch',
    chime: 'Glockenspiel',
    pop: 'Plopp',
    bell: 'Glocke',
    droplet: 'Tropfen',
    marimba: 'Marimba',
    custom: 'Dein eigener Ton',
    none: 'Kein Ton',
  },
  kinds: {
    message: 'Nachrichten',
    mention: 'Erwähnungen und Antworten',
    dm: 'Direktnachrichten',
  },
  preview: 'Abspielen',
  previewOf: '{{sound}} abspielen',
  inherit: 'Wie bei dir ({{sound}})',
  customMissing: 'Dein eigener Ton (auf diesem Gerät läuft Klassisch)',
  syncHint: 'Deine Auswahl folgt dir auf deine anderen Geräte. Ein Server oder Kanal kann einen eigenen Ton haben: Wähle ihn in seinem Menü.',
  menuRow: 'Ton',
  menuTitle: 'Ton für {{place}}',
  yourDefault: 'Dein Ton',
  serverDefault: 'Ton des Servers',
  custom: {
    heading: 'Dein eigener Ton',
    upload: 'Ton hochladen',
    replace: 'Ersetzen',
    remove: 'Entfernen',
    current: '{{name}} ({{seconds}} s)',
    hint: 'Eine kurze Tondatei: bis 4 Sekunden und 1 MB. Sie bleibt auf diesem Gerät und wird nie hochgeladen; deine anderen Geräte spielen stattdessen Klassisch.',
    problems: {
      notAudio: 'Das ist keine Tondatei.',
      tooBig: 'Die Datei ist zu groß. Wähle eine bis 1 MB.',
      tooLong: 'Der Ton ist zu lang. Wähle einen bis 4 Sekunden.',
      empty: 'Dieser Ton ist still.',
      unreadable: 'Der Ton ließ sich hier nicht abspielen. Versuch eine MP3-, Ogg- oder WAV-Datei.',
    },
  },
}
