import type { Messages } from '../types'

export const account: Messages['account'] = {
  welcome: {
    lead: 'Rozmowy głosowe i czat ze znajomymi na serwerach, które należą do was.',
    question: 'Masz już konto Iskra?',
    step: 'Krok {{step}} z {{of}}',
    new: 'Iskra to dla mnie nowość',
    newHint: 'Wybierz nazwę i gotowe. Bez e-maila i bez hasła.',
    existing: 'Mam już konto Iskra na innym urządzeniu',
    existingHint: 'Połącz to urządzenie ze swoim kontem albo użyj klucza odzyskiwania. Twoje serwery, znajomi i wiadomości przejdą razem z tobą.',
    back: 'Wstecz',
    invitedTwice: 'Masz już za sobą dołączanie z innego urządzenia lub przeglądarki? Wybierz „Mam już konto Iskra”. Nowe konto pojawi się na serwerze jako nowa osoba.',
  },
  signOut: {
    button: 'Wyloguj się z tego urządzenia',
    hint: 'Usuwa twoje konto tylko z tego urządzenia.',
    title: 'Wyloguj się z tego urządzenia',
    intro: 'To usunie klucze, wiadomości i ustawienia twojego konta z tego urządzenia, a to urządzenie z twojego konta. Potem Iskra zacznie tu od zera.',
    otherDevices_one: 'Twoje konto zostaje na twoim drugim urządzeniu, więc nic nie przepadnie.',
    otherDevices_few: 'Twoje konto zostaje na {{count}} innych urządzeniach, więc nic nie przepadnie.',
    otherDevices_many: 'Twoje konto zostaje na {{count}} innych urządzeniach, więc nic nie przepadnie.',
    otherDevices_other: 'Twoje konto zostaje na {{count}} innych urządzeniach, więc nic nie przepadnie.',
    onlyDevice: 'To jedyne urządzenie z twoim kontem. Żeby znów z niego korzystać, będziesz potrzebować klucza odzyskiwania.',
    dangerTitle: 'Stracisz to konto na zawsze',
    danger: 'To twoje jedyne urządzenie, a klucz odzyskiwania nie jest zapisany. Jeśli się teraz wylogujesz, nikt nie przywróci tego konta: ani ty, ani właściciel serwera.',
    saveFirst: 'Najpierw zapisz klucz odzyskiwania',
    understand: 'Rozumiem, że to konto zniknie na zawsze',
    leave: 'Opuść też moje serwery',
    leaveHint: 'Twoje konto opuści je na każdym urządzeniu: znikniesz z list członków i do powrotu będziesz potrzebować nowego zaproszenia. Na serwerach, których jesteś właścicielem, zostajesz.',
    confirm: 'Wyloguj się',
    busy: 'Wylogowywanie…',
  },
}
