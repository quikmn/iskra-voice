// The quiz's bundled questions (general knowledge, easy to medium). `correct` is the index of the right option;
// the quizmaster's app shuffles the options before sending them.
export interface BankQuestion {
  text: string
  options: string[]
  correct: number
}

export const QUESTIONS: Record<'en' | 'sv', BankQuestion[]> = {
  en: [
    { text: 'Which planet is known as the Red Planet?', options: ['Mars', 'Venus', 'Jupiter', 'Mercury'], correct: 0 },
    { text: 'How many legs does a spider have?', options: ['Eight', 'Six', 'Ten', 'Twelve'], correct: 0 },
    { text: 'What is the largest ocean on Earth?', options: ['The Pacific', 'The Atlantic', 'The Indian Ocean', 'The Arctic Ocean'], correct: 0 },
    { text: 'Which gas do plants take in from the air to make food?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'], correct: 0 },
    { text: 'How many minutes are there in a day?', options: ['1,440', '1,200', '2,400', '960'], correct: 0 },
    { text: 'What is the capital of Japan?', options: ['Tokyo', 'Kyoto', 'Osaka', 'Seoul'], correct: 0 },
    { text: 'Which instrument has 88 keys?', options: ['The piano', 'The organ', 'The accordion', 'The harpsichord'], correct: 0 },
    { text: 'What is H₂O better known as?', options: ['Water', 'Salt', 'Hydrogen peroxide', 'Steam'], correct: 0 },
    { text: 'Which is the smallest prime number?', options: ['2', '1', '3', '0'], correct: 0 },
    { text: 'In which country are the pyramids of Giza?', options: ['Egypt', 'Mexico', 'Peru', 'Sudan'], correct: 0 },
    { text: 'What colour do you get by mixing blue and yellow?', options: ['Green', 'Purple', 'Orange', 'Brown'], correct: 0 },
    { text: 'Which animal is the largest living mammal?', options: ['The blue whale', 'The African elephant', 'The giraffe', 'The sperm whale'], correct: 0 },
    { text: 'How many sides does a hexagon have?', options: ['Six', 'Five', 'Seven', 'Eight'], correct: 0 },
    { text: 'Which metal is liquid at room temperature?', options: ['Mercury', 'Lead', 'Tin', 'Aluminium'], correct: 0 },
    { text: 'What is the hardest natural material?', options: ['Diamond', 'Granite', 'Quartz', 'Iron'], correct: 0 },
    { text: 'Which continent is the Sahara desert on?', options: ['Africa', 'Asia', 'Australia', 'South America'], correct: 0 },
    { text: 'How many players are on a football (soccer) team on the pitch?', options: ['Eleven', 'Ten', 'Nine', 'Twelve'], correct: 0 },
    { text: 'Which is the closest star to Earth?', options: ['The Sun', 'Proxima Centauri', 'Sirius', 'Polaris'], correct: 0 },
    { text: 'What do bees make?', options: ['Honey', 'Silk', 'Wax paper', 'Maple syrup'], correct: 0 },
    { text: 'How many continents are there?', options: ['Seven', 'Five', 'Six', 'Eight'], correct: 0 },
  ],
  sv: [
    { text: 'Vilken planet kallas den röda planeten?', options: ['Mars', 'Venus', 'Jupiter', 'Merkurius'], correct: 0 },
    { text: 'Hur många ben har en spindel?', options: ['Åtta', 'Sex', 'Tio', 'Tolv'], correct: 0 },
    { text: 'Vilket är jordens största hav?', options: ['Stilla havet', 'Atlanten', 'Indiska oceanen', 'Norra ishavet'], correct: 0 },
    { text: 'Vilken gas tar växter upp från luften för att göra näring?', options: ['Koldioxid', 'Syre', 'Kväve', 'Helium'], correct: 0 },
    { text: 'Hur många minuter går det på ett dygn?', options: ['1 440', '1 200', '2 400', '960'], correct: 0 },
    { text: 'Vad heter Japans huvudstad?', options: ['Tokyo', 'Kyoto', 'Osaka', 'Seoul'], correct: 0 },
    { text: 'Vilket instrument har 88 tangenter?', options: ['Pianot', 'Orgeln', 'Dragspelet', 'Cembalon'], correct: 0 },
    { text: 'Vad är H₂O mer känt som?', options: ['Vatten', 'Salt', 'Väteperoxid', 'Ånga'], correct: 0 },
    { text: 'Vilket är det minsta primtalet?', options: ['2', '1', '3', '0'], correct: 0 },
    { text: 'I vilket land ligger pyramiderna i Giza?', options: ['Egypten', 'Mexiko', 'Peru', 'Sudan'], correct: 0 },
    { text: 'Vilken färg får du om du blandar blått och gult?', options: ['Grönt', 'Lila', 'Orange', 'Brunt'], correct: 0 },
    { text: 'Vilket är det största däggdjuret som lever i dag?', options: ['Blåvalen', 'Afrikansk elefant', 'Giraffen', 'Kaskeloten'], correct: 0 },
    { text: 'Hur många sidor har en hexagon?', options: ['Sex', 'Fem', 'Sju', 'Åtta'], correct: 0 },
    { text: 'Vilken metall är flytande i rumstemperatur?', options: ['Kvicksilver', 'Bly', 'Tenn', 'Aluminium'], correct: 0 },
    { text: 'Vilket är det hårdaste naturliga materialet?', options: ['Diamant', 'Granit', 'Kvarts', 'Järn'], correct: 0 },
    { text: 'På vilken kontinent ligger Saharaöknen?', options: ['Afrika', 'Asien', 'Australien', 'Sydamerika'], correct: 0 },
    { text: 'Hur många spelare har ett fotbollslag på planen?', options: ['Elva', 'Tio', 'Nio', 'Tolv'], correct: 0 },
    { text: 'Vilken stjärna ligger närmast jorden?', options: ['Solen', 'Proxima Centauri', 'Sirius', 'Polstjärnan'], correct: 0 },
    { text: 'Vad gör bin?', options: ['Honung', 'Silke', 'Smörpapper', 'Lönnsirap'], correct: 0 },
    { text: 'Hur många kontinenter finns det?', options: ['Sju', 'Fem', 'Sex', 'Åtta'], correct: 0 },
  ],
}
