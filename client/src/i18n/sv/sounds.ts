import type { Messages } from '../types'

export const sounds: Messages['sounds'] = {
  heading: 'Ljud',
  names: {
    classic: 'Klassiskt',
    chime: 'Klinga',
    pop: 'Plopp',
    bell: 'Klocka',
    droplet: 'Droppe',
    marimba: 'Marimba',
    custom: 'Ditt eget ljud',
    none: 'Inget ljud',
  },
  kinds: {
    message: 'Meddelanden',
    mention: 'Omnämnanden och svar',
    dm: 'Direktmeddelanden',
  },
  preview: 'Spela',
  previewOf: 'Spela {{sound}}',
  inherit: 'Samma som ditt ({{sound}})',
  customMissing: 'Ditt eget ljud (spelar Klassiskt på den här enheten)',
  syncHint: 'Dina val följer med till dina andra enheter. En server eller kanal kan ha ett eget ljud: välj det i dess meny.',
  menuRow: 'Ljud',
  menuTitle: 'Ljud för {{place}}',
  yourDefault: 'Ditt ljud',
  serverDefault: 'Serverns ljud',
  custom: {
    heading: 'Ditt eget ljud',
    upload: 'Ladda upp ett ljud',
    replace: 'Byt',
    remove: 'Ta bort',
    current: '{{name}} ({{seconds}} s)',
    hint: 'En kort ljudfil: högst 4 sekunder och 1 MB. Den stannar på den här enheten och laddas aldrig upp; dina andra enheter spelar Klassiskt i stället.',
    problems: {
      notAudio: 'Det där är ingen ljudfil.',
      tooBig: 'Filen är för stor. Välj en på högst 1 MB.',
      tooLong: 'Ljudet är för långt. Välj ett på högst 4 sekunder.',
      empty: 'Ljudet är tyst.',
      unreadable: 'Ljudet gick inte att spela här. Prova en MP3-, OGG- eller WAV-fil.',
    },
  },
}
