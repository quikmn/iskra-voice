import type { Messages } from '../types'

export const account: Messages['account'] = {
  welcome: {
    lead: 'Sprach- und Textchat mit deinen Freunden, auf Servern, die euch gehören.',
    question: 'Hast du Iskra schon mal benutzt?',
    step: 'Schritt {{step}} von {{of}}',
    new: 'Ich bin neu bei Iskra',
    newHint: 'Such dir einen Namen aus und du bist dabei. Keine E-Mail, kein Passwort.',
    existing: 'Ich nutze Iskra schon auf einem anderen Gerät',
    existingHint: 'Verknüpfe dieses Gerät mit deinem Konto oder nimm deinen Wiederherstellungsschlüssel. Deine Server, Freunde und Nachrichten kommen mit.',
    back: 'Zurück',
    invitedTwice: 'Schon mal von einem anderen Gerät oder Browser beigetreten? Wähle „Ich nutze Iskra schon“. Ein neues Konto erscheint auf dem Server als neue Person.',
  },
  signOut: {
    button: 'Von diesem Gerät abmelden',
    hint: 'Entfernt dein Konto nur von diesem Gerät.',
    title: 'Von diesem Gerät abmelden',
    intro: 'Das entfernt die Schlüssel, Nachrichten und Einstellungen deines Kontos von diesem Gerät und dieses Gerät aus deinem Konto. Danach startet Iskra hier neu.',
    otherDevices_one: 'Dein Konto bleibt auf deinem anderen Gerät, es geht also nichts verloren.',
    otherDevices_other: 'Dein Konto bleibt auf deinen {{count}} anderen Geräten, es geht also nichts verloren.',
    onlyDevice: 'Dies ist das einzige Gerät mit deinem Konto. Um es wieder zu nutzen, brauchst du deinen Wiederherstellungsschlüssel.',
    dangerTitle: 'Du verlierst dieses Konto für immer',
    danger: 'Dies ist dein einziges Gerät und du hast deinen Wiederherstellungsschlüssel nicht gesichert. Wenn du dich jetzt abmeldest, kann niemand dieses Konto zurückholen: weder du noch ein Serverbesitzer.',
    saveFirst: 'Erst Schlüssel sichern',
    understand: 'Ich verstehe, dass dieses Konto für immer weg ist',
    leave: 'Auch meine Server verlassen',
    leaveHint: 'Dein Konto verlässt sie auf allen Geräten: Du verschwindest aus den Mitgliederlisten und brauchst eine neue Einladung, um zurückzukommen. In Servern, die dir gehören, bleibst du.',
    confirm: 'Abmelden',
    busy: 'Meldet ab…',
  },
}
