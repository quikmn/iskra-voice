// account-text (svenska). Samma nycklar som ../en/account.ts.
import type { Messages } from '../types'

export const account: Messages['account'] = {
  welcome: {
    lead: 'Röst- och textchatt med dina vänner, på servrar du själv äger.',
    question: 'Har du använt Iskra förut?',
    new: 'Jag är ny på Iskra',
    newHint: 'Välj ett namn så är du igång. Ingen e-post, inget lösenord.',
    existing: 'Jag använder redan Iskra på en annan enhet',
    existingHint: 'Koppla den här enheten till ditt konto, eller använd din återställningsnyckel. Dina servrar, vänner och meddelanden följer med.',
    back: 'Tillbaka',
    invitedTwice: 'Har du gått med från en annan enhet eller webbläsare förut? Välj ”Jag använder redan Iskra”. Ett nytt konto syns som en ny person på servern.',
  },
  signOut: {
    button: 'Logga ut från den här enheten',
    hint: 'Tar bara bort ditt konto från den här enheten.',
    title: 'Logga ut från den här enheten',
    intro: 'Det här tar bort ditt kontos nycklar, meddelanden och inställningar från den här enheten, och enheten från ditt konto. Sedan börjar Iskra om från början här.',
    otherDevices_one: 'Ditt konto finns kvar på din andra enhet, så inget går förlorat.',
    otherDevices_other: 'Ditt konto finns kvar på dina {{count}} andra enheter, så inget går förlorat.',
    onlyDevice: 'Det här är den enda enheten med ditt konto. För att använda det igen behöver du din återställningsnyckel.',
    dangerTitle: 'Du förlorar kontot för alltid',
    danger: 'Det här är din enda enhet och du har inte sparat din återställningsnyckel. Om du loggar ut nu kan ingen få tillbaka kontot: inte du, och inte heller någon serverägare.',
    saveFirst: 'Spara återställningsnyckeln först',
    understand: 'Jag förstår att kontot försvinner för alltid',
    leave: 'Lämna också mina servrar',
    leaveHint: 'Ditt konto lämnar dem på alla enheter: du försvinner från medlemslistorna och behöver en ny inbjudan för att komma tillbaka. Servrar du äger stannar du kvar i.',
    confirm: 'Logga ut',
    busy: 'Loggar ut…',
  },
}
