import type { Messages } from '../types'

export const streamer: Messages['streamer'] = {
  title: 'Streamerläge',
  pill: 'Streamerläge',
  pillHint: 'Streamerläget är på: inbjudningslänkar, id:n och förhandsvisningar döljs och aviseringar är tysta. Stäng av det i Mina inställningar eller statusmenyn.',
  switch: 'Streamerläge',
  switchHint: 'För när din skärm syns i en stream: döljer inbjudningslänkar och koder, konto-id:n och säkerhetsnummer, e-postadresser i profiler och förhandsvisningar av meddelanden, och håller aviseringar och ljud tysta. Följer med ditt konto till dina andra enheter.',
  on: 'På',
  off: 'Av',
  autoTitle: 'Slå på av sig självt',
  auto: 'Medan ett program från min lista nedan körs',
  autoHint: 'Lägg till OBS, Streamlabs eller det du streamar med i programlistan, så slår streamerläget på sig självt medan programmet körs och av när det avslutas. Bara på den här datorn, och bara de program du lagt till letas efter.',
  autoNow: 'Ett program från din lista körs: streamerläget är på.',
  autoDesktopOnly: 'Skrivbordsappen kan också slå på det av sig självt medan ditt streamingprogram körs:',
  hidden: 'Dolt i streamerläge',
  hiddenShort: 'Dolt',
  menu: {
    on: 'Streamerläget är på',
    off: 'Streamerläge',
    turnOff: 'Stäng av',
    turnOn: 'Slå på',
    autoOn: 'På medan ditt streamingprogram körs',
  },
}
