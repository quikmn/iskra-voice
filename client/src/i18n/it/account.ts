import type { Messages } from '../types'

export const account: Messages['account'] = {
  welcome: {
    lead: 'Chat vocale e testuale con i tuoi amici, su server tutti vostri.',
    question: 'Hai già usato Iskra?',
    step: 'Passaggio {{step}} di {{of}}',
    new: 'È la prima volta che uso Iskra',
    newHint: 'Scegli un nome e ci sei. Niente email, niente password.',
    existing: 'Uso già Iskra su un altro dispositivo',
    existingHint: 'Collega questo dispositivo al tuo account, oppure usa la chiave di recupero. I tuoi server, amici e messaggi vengono con te.',
    back: 'Indietro',
    invitedTwice: 'Hai già usato questo server da un altro dispositivo o browser? Scegli «Uso già Iskra». Un nuovo account compare sul server come una nuova persona.',
  },
  signOut: {
    button: 'Esci da questo dispositivo',
    hint: 'Rimuove il tuo account solo da questo dispositivo.',
    title: 'Esci da questo dispositivo',
    intro: 'Così rimuovi le chiavi, i messaggi e le impostazioni del tuo account da questo dispositivo, e questo dispositivo dal tuo account. Poi Iskra riparte da zero qui.',
    otherDevices_one: "Il tuo account resta sull'altro tuo dispositivo, quindi non si perde nulla.",
    otherDevices_other: 'Il tuo account resta sugli altri tuoi {{count}} dispositivi, quindi non si perde nulla.',
    onlyDevice: "Questo è l'unico dispositivo con il tuo account. Per usarlo di nuovo ti servirà la chiave di recupero.",
    dangerTitle: 'Perderai questo account per sempre',
    danger: 'Questo è il tuo unico dispositivo e non hai salvato la chiave di recupero. Se esci adesso, nessuno potrà recuperare questo account: né tu, né il proprietario di un server.',
    saveFirst: 'Prima salva la chiave di recupero',
    understand: 'Ho capito che questo account andrà perso per sempre',
    leave: 'Abbandona anche i miei server',
    leaveHint: 'Il tuo account li abbandona su ogni dispositivo: sparisci dai loro elenchi dei membri e per tornare ti serve un nuovo invito. Resti nei server di cui hai la proprietà.',
    confirm: 'Esci',
    busy: 'Uscita…',
  },
}
