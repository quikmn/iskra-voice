// Words to draw: everyday things that are fun to sketch. The drawer's app offers three; the drawer picks one.
export const WORDS: Record<'en' | 'sv', string[]> = {
  en: [
    'apple', 'banana', 'bicycle', 'bridge', 'butterfly', 'cactus', 'camera', 'candle', 'castle', 'cat', 'chair', 'cloud',
    'crown', 'dinosaur', 'dog', 'dragon', 'drum', 'duck', 'elephant', 'envelope', 'fish', 'flower', 'ghost', 'giraffe',
    'glasses', 'guitar', 'hamburger', 'hammer', 'hat', 'helicopter', 'house', 'ice cream', 'island', 'jellyfish', 'kite',
    'ladder', 'lamp', 'lighthouse', 'lion', 'mountain', 'mushroom', 'octopus', 'owl', 'penguin', 'piano', 'pizza',
    'pineapple', 'pirate', 'rabbit', 'rainbow', 'robot', 'rocket', 'sailboat', 'sandwich', 'scissors', 'shark', 'snail',
    'snowman', 'spider', 'star', 'sun', 'sword', 'tent', 'tiger', 'toothbrush', 'tractor', 'train', 'tree', 'umbrella',
    'unicorn', 'volcano', 'whale', 'windmill', 'wizard', 'zebra', 'balloon', 'bee', 'book', 'bottle', 'cake', 'carrot',
    'clock', 'cow', 'dolphin', 'door', 'egg', 'feather', 'fire', 'frog', 'key', 'moon', 'mouse', 'pencil', 'phone',
    'skateboard', 'snake', 'spoon', 'teapot', 'turtle', 'watermelon',
  ],
  sv: [
    'äpple', 'banan', 'cykel', 'bro', 'fjäril', 'kaktus', 'kamera', 'ljus', 'slott', 'katt', 'stol', 'moln', 'krona',
    'dinosaurie', 'hund', 'drake', 'trumma', 'anka', 'elefant', 'kuvert', 'fisk', 'blomma', 'spöke', 'giraff',
    'glasögon', 'gitarr', 'hamburgare', 'hammare', 'hatt', 'helikopter', 'hus', 'glass', 'ö', 'manet', 'drake',
    'stege', 'lampa', 'fyr', 'lejon', 'berg', 'svamp', 'bläckfisk', 'uggla', 'pingvin', 'piano', 'pizza', 'ananas',
    'pirat', 'kanin', 'regnbåge', 'robot', 'raket', 'segelbåt', 'smörgås', 'sax', 'haj', 'snigel', 'snögubbe', 'spindel',
    'stjärna', 'sol', 'svärd', 'tält', 'tiger', 'tandborste', 'traktor', 'tåg', 'träd', 'paraply', 'enhörning',
    'vulkan', 'val', 'väderkvarn', 'trollkarl', 'zebra', 'ballong', 'bi', 'bok', 'flaska', 'tårta', 'morot', 'klocka',
    'ko', 'delfin', 'dörr', 'ägg', 'fjäder', 'eld', 'groda', 'nyckel', 'måne', 'mus', 'penna', 'telefon', 'skateboard',
    'orm', 'sked', 'tekanna', 'sköldpadda', 'vattenmelon', 'älg', 'midsommarstång',
  ],
}

/** Three different words, picked at random. */
export function threeWords(list: readonly string[], random: () => number = Math.random): string[] {
  const unique = [...new Set(list)]
  const picked: string[] = []
  while (picked.length < 3 && picked.length < unique.length) {
    const word = unique[Math.floor(random() * unique.length)]
    if (!picked.includes(word)) picked.push(word)
  }
  return picked
}
