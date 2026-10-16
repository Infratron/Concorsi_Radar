/**
 * Titoli leggibili.
 *
 * Il titolo di un concorso finisce in chat, davanti a una persona: un titolo
 * urlato ("LA CACCIA AL TESORO DEL CAPITANO") o con le parole incollate
 * ("Vinciwonka2026", "ŠKODAXFACTOR2026") si legge male e sembra un errore del
 * bot. Qui si sistema solo la FORMA — maiuscole, spazi, confini fra parola e
 * anno — senza inventare parole che non conosciamo: un titolo già scritto bene
 * deve uscire di qui identico.
 */

/**
 * Paroline che in italiano restano minuscole dentro una frase. Non si applicano
 * alla prima parola del titolo.
 */
const SMALL_WORDS = new Set([
  "di", "a", "da", "in", "con", "su", "per", "tra", "fra", "e", "ed", "o",
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
  "del", "della", "dei", "delle", "al", "alla", "allo", "agli", "alle",
  "dal", "dalla", "nel", "nella", "sul", "sulla",
]);

/** Anno attaccato alle lettere: "Vinciwonka2026" → "Vinciwonka 2026". */
const GLUED_YEAR = /(\p{L})((?:19|20)\d{2})\b/gu;

/*
 * Non si separano le parole incollate in mezzo ("GlowWin", "InPost"): non c'è
 * modo di distinguere un refuso da un marchio scritto così, e il costo è tutto
 * dalla parte sbagliata. Misurato sull'archivio del 16/10/2026: la regola
 * migliorava "GlowWin" ma rovinava "InPost" → "In Post", "KitchenAid" →
 * "Kitchen Aid" e "TheFork" → "The Fork". Meglio un nome incollato che un
 * marchio sbagliato: l'anno attaccato invece si separa sempre, perché lì il
 * confine è certo.
 */

/** Quota di maiuscole oltre la quale il titolo è "urlato". */
const SHOUTING_RATIO = 0.6;
/** Sotto questo numero di lettere non si giudica: "TIM" e "PS5" sono sigle. */
const SHOUTING_MIN_LETTERS = 6;

function letterStats(input: string): { total: number; upper: number } {
  const letters = input.match(/\p{L}/gu) ?? [];
  let upper = 0;
  for (const letter of letters) {
    if (letter !== letter.toLowerCase() && letter === letter.toUpperCase()) upper++;
  }
  return { total: letters.length, upper };
}

/** true se il titolo è scritto tutto (o quasi) in maiuscolo. */
function isShouting(input: string): boolean {
  const { total, upper } = letterStats(input);
  if (total < SHOUTING_MIN_LETTERS) return false;
  return upper / total >= SHOUTING_RATIO;
}

/**
 * Maiuscola la prima LETTERA della parola, non il primo carattere: altrimenti
 * «premio» resterebbe minuscolo dentro le virgolette.
 */
function capitalizeFirstLetter(word: string): string {
  const lower = word.toLowerCase();
  const index = lower.search(/\p{L}/u);
  if (index === -1) return lower;
  return `${lower.slice(0, index)}${lower.charAt(index).toUpperCase()}${lower.slice(index + 1)}`;
}

/**
 * Dopo questi segni comincia una frase nuova: lì anche la parolina torna
 * maiuscola, altrimenti "KRAFT E MORATO – LA COMBO PERFETTA" diventerebbe
 * "Kraft e Morato – la Combo Perfetta", che sembra un errore di battitura.
 */
const CLAUSE_BREAK = /[–—:;.!?»\)]$/;

/** Da urlato a leggibile, con le paroline italiane minuscole. */
function toReadableCase(input: string): string {
  let inizioFrase = true;
  return input
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      const parolina = !inizioFrase && SMALL_WORDS.has(lower);
      inizioFrase = CLAUSE_BREAK.test(word);
      return parolina ? lower : capitalizeFirstLetter(word);
    })
    .join(" ");
}

/**
 * Titolo come va mostrato all'utente.
 * È una funzione pura e idempotente: applicarla due volte non cambia il
 * risultato, quindi la si può usare sia in ingresso (prima di salvare) sia in
 * uscita (prima di scrivere in chat) senza sorprese.
 */
export function readableTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  const spaced = collapsed.replace(GLUED_YEAR, "$1 $2");
  return isShouting(spaced) ? toReadableCase(spaced) : spaced;
}
