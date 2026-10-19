import type { Insight, RawItem } from "../types.ts";
import { decodeEntities, stripBoilerplate, stripHtml, truncate } from "../lib/text.ts";

/**
 * Arricchimento a regole: deterministico, senza costi e senza rete.
 * Estrae scadenza, premio, modalità di partecipazione, sforzo e tag.
 *
 * Vincolo di progetto: questo codice gira su Workers Free, dove ogni
 * invocazione ha 10 ms di CPU. Per questo il testo viene normalizzato UNA volta
 * e condiviso da tutti gli estrattori: prima ognuno si rifaceva decodeEntities +
 * toLowerCase sull'intero testo, quattro passate a item.
 */

/** Oltre questa soglia il testo non serve più: le informazioni utili stanno in testa. */
export const MAX_EXTRACTION_CHARS = 900;

export const MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
  gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12,
};

/** Parole che rendono una data una vera scadenza e non una data di inizio. */
const DEADLINE_KEYWORDS = [
  "scad", "entro", "termine", "fino al", "fino a", "ultimo giorno", "ultimi giorni",
  "chiude", "chiudono", "conclude", "si conclude", "non oltre", "valido fino",
  "prorogat", "prima del", "massimo entro", "tempo fino",
];

const MAX_FUTURE_DAYS = 730;
const GRACE_DAYS = 45;

/** Testo pronto per l'estrazione: boilerplate via, entità decodificate, minuscole. */
export interface NormalizedText {
  /** Testo originale ripulito: serve per i ritagli che devono conservare le maiuscole. */
  raw: string;
  /** Stessa cosa in minuscolo: tutte le ricerche girano qui. */
  lower: string;
}

export function normalizeForExtraction(text: string): NormalizedText {
  const raw = truncate(stripBoilerplate(decodeEntities(text)), MAX_EXTRACTION_CHARS);
  return { raw, lower: raw.toLowerCase() };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** YYYY-MM-DD validando il calendario (scarta 31/02 e simili). */
export function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${check.getUTCFullYear()}-${pad(month)}-${pad(day)}`;
}

function daysBetween(from: Date, iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / 86_400_000,
  );
}

interface Candidate {
  date: string;
  index: number;
  keyworded: boolean;
}

function resolveYear(year: number | undefined, month: number, day: number, now: Date): string | null {
  if (year !== undefined) {
    return isoDate(year < 100 ? 2000 + year : year, month, day);
  }
  const current = isoDate(now.getUTCFullYear(), month, day);
  if (current && daysBetween(now, current) >= -GRACE_DAYS) return current;
  return isoDate(now.getUTCFullYear() + 1, month, day);
}

/**
 * L'anno scritto ACCANTO a una data, quando c'è: "dal 25 novembre al 10 dicembre
 * 2024" ha l'anno in fondo, dopo l'altra data, e la regex della data presa da
 * sola non lo vede.
 *
 * Perché serve: senza, quel "25 novembre" veniva portato all'anno corrente e una
 * promozione chiusa nel 2024 entrava in archivio con la scadenza del 2026 — la
 * sezione 📰 News si è riempita di pagine AIA morte proprio così (misurato il
 * 17/10/2026: sei item, tre con l'anno sbagliato).
 */
function nearbyYear(text: string, from: number): number | undefined {
  const window = text.slice(from, from + 48).split(/[.;\n]/, 1)[0] ?? "";
  const found = /\b(20\d{2})\b/.exec(window);
  return found ? Number(found[1]) : undefined;
}

function hasDeadlineKeyword(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 48), index);
  return DEADLINE_KEYWORDS.some((keyword) => window.includes(keyword));
}

/**
 * Scadenza più plausibile: preferisce le date annunciate da una parola chiave
 * ("scade il", "entro il", "termine ultimo") e, tra queste, la più lontana,
 * perché è quella che chiude il concorso.
 */
function deadlineFrom(haystack: NormalizedText, now: Date): string | null {
  const text = haystack.lower;
  const candidates: Candidate[] = [];

  const numeric = /(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/g;
  let match: RegExpExecArray | null;
  while ((match = numeric.exec(text)) !== null) {
    const year = match[3] !== undefined ? Number(match[3]) : undefined;
    const date = resolveYear(year, Number(match[2]), Number(match[1]), now);
    if (date) candidates.push({ date, index: match.index, keyworded: hasDeadlineKeyword(text, match.index) });
  }

  const textual = /(\d{1,2})\s+(?:di\s+)?([a-z]+)\s*(\d{4})?/g;
  while ((match = textual.exec(text)) !== null) {
    const month = MONTHS[match[2]];
    if (month === undefined) continue;
    // L'anno può stare dopo la SECONDA data di un intervallo: "dal 25 novembre
    // al 10 dicembre 2024". Senza questo, la prima data veniva portata all'anno
    // corrente e l'intervallo tornava a essere "aperto".
    const year = match[3] !== undefined ? Number(match[3]) : nearbyYear(text, match.index + match[0].length);
    const date = resolveYear(year, month, Number(match[1]), now);
    if (date) candidates.push({ date, index: match.index, keyworded: hasDeadlineKeyword(text, match.index) });
  }

  const usable = candidates.filter((candidate) => {
    const delta = daysBetween(now, candidate.date);
    return delta >= -1 && delta <= MAX_FUTURE_DAYS;
  });
  if (usable.length === 0) return null;

  const keyworded = usable.filter((candidate) => candidate.keyworded);
  const pool = keyworded.length > 0 ? keyworded : usable;
  return pool.reduce((latest, candidate) => (candidate.date > latest ? candidate.date : latest), pool[0].date);
}

/**
 * La fine di un intervallo di date esplicito ("dal 26 agosto al 16 settembre
 * 2026"), anche quando è nel passato.
 *
 * `deadlineFrom` guarda solo avanti — una scadenza passata non è una scadenza —
 * ma per il cancello di freschezza quella è esattamente la prova che serve: una
 * promozione stagionale il cui intervallo è finito è un'edizione chiusa, non un
 * concorso appena uscito. Caso reale: le pagine AIA "Dal … Al …" finite in 📰
 * News con la data di chiusura già passata (17/10/2026).
 */
const DATE_RANGE = /\bdal\s+(\d{1,2})\s+(?:di\s+)?([a-z]+)\s*(\d{4})?\s*(?:al|fino al|fino a)\s+(\d{1,2})\s+(?:di\s+)?([a-z]+)\s*(\d{4})?/i;

export function endOfDateRange(text: string): string | null {
  // `MONTHS` è in minuscolo: la corrispondenza va cercata sul testo normalizzato,
  // come fa deadlineFrom. Senza, "Settembre" non trovava il mese.
  const match = DATE_RANGE.exec(text.toLowerCase());
  if (!match) return null;
  const month = MONTHS[match[5] ?? ""];
  if (month === undefined) return null;
  const year = Number(match[6] ?? match[3]);
  if (!Number.isInteger(year) || year < 2000) return null;
  return isoDate(year, month, Number(match[4]));
}

/** Valore stimato del premio, 0..1, da importi in euro e parole chiave. */
const PRIZE_TIERS: { value: number; pattern: RegExp }[] = [
  { value: 1, pattern: /\b(auto|automobile|macchina nuova|suv|moto|scooter|e-?bike|viaggio|vacanza|crociera|weekend per due)\b/ },
  // Marche di auto e moto: nei concorsi il premio è spesso "una Fiat Panda", senza la parola "auto".
  { value: 1, pattern: /\b(fiat|panda|punto|jeep|renault|peugeot|citroen|toyota|volkswagen|dacia|opel|ford|hyundai|kia|tesla|bmw|audi|mercedes|skoda|seat|smart|piaggio|vespa|yamaha|kymco|ducati)\b/ },
  { value: 1, pattern: /\b(cash|contanti|denaro|denaro in palio|bonifico)\b/ },
  { value: 0.95, pattern: /\b(gift ?card|buono regalo|carta regalo|buoni spesa|buono spesa|voucher)\b/ },
  { value: 0.9, pattern: /\b(iphone|ipad|macbook|smartphone|tablet|playstation|ps5|xbox|nintendo switch|oled|tv \d|televisore|frigorifero|lavatrice)\b/ },
  { value: 0.7, pattern: /\b(smartwatch|cuffie|auricolari|robot aspirapolvere|aspirapolvere|console|bici|monopattino|frullatore|caffettiera)\b/ },
  { value: 0.55, pattern: /\b(biglietti|biglietto|ingressi|cena|pranzo|soggiorno|buoni sconto|coupon|abbonamento)\b/ },
  { value: 0.25, pattern: /\b(gadget|omaggio|omaggi|campioni|kit|maglietta|cappellino|borraccia|tazza|portachiavi|adesivi|prodotti)\b/ },
];

/**
 * Il premio va tenuto corto: "In palio una Fiat Panda, scade il 25 ottobre"
 * deve diventare "una Fiat Panda", non l'intera frase fino alla scadenza.
 */
function firstClause(raw: string): string {
  const oneLine = stripHtml(raw).replace(/\s+/g, " ").trim();
  const beforeBoundary = oneLine.split(/[,;.]|\s(?:scade|scadenza|entro|valido|termine|partecipa)\b/i)[0] ?? oneLine;
  return beforeBoundary.replace(/^[\s:–-]+/, "").trim();
}

function prizeFrom(haystack: NormalizedText): { prize: string | null; prizeValue: number } {
  const stated =
    /(?:premi[o]?|in palio|si vince|si possono vincere|si pu[oò] vincere|vincita|montepremi)[\s:–-]+([^.\n]{6,200})/i.exec(haystack.raw) ??
    /(?:premi[o]?|in palio)[\s:–-]+([^.\n]{6,200})/i.exec(haystack.raw);
  const prize = stated ? truncate(firstClause(stated[1]), 160) : null;

  const tier = PRIZE_TIERS.find((entry) => entry.pattern.test(haystack.lower));
  return { prize: prize && prize.length > 0 ? prize : null, prizeValue: Math.min(1, Math.max(0, tier?.value ?? (prize ? 0.4 : 0.3))) };
}

const NO_PURCHASE_PATTERNS = [
  /senza\s+(?:alcun\s+)?obbligo\s+(?:di\s+|d')acquisto/,
  /senza\s+acquisto/,
  /non\s+[eè]\s+richiesto\s+(?:alcun\s+)?acquisto/,
  /senza\s+spendere\s+niente/,
  /partecipazione\s+gratuita/,
];

const PURCHASE_PATTERNS = [
  /acquist/, /scontrin/, /\bspes[ao]\b/, /raccolta\s+punti/, /punti\s+(?:fedelt|esselunga|conad|coop)/,
  /carta\s+fedelt/, /minimo\s+di\s+spesa/, /codice\s+(?:sullo|sul|presente)/, /confezion/,
];

// Attenzione ai confini di parola: "acquist" e "confezion" sono prefissi, quindi
// niente \b finale, altrimenti "acquisto"/"confezione" non verrebbero riconosciuti.
const EFFORT_PATTERNS: { delta: number; pattern: RegExp }[] = [
  { delta: 0.25, pattern: /(gratis|gratuito|gratuita|senza acquisto)/ },
  { delta: 0.15, pattern: /(basta|un click|un clic|una registrazione|compila il form|semplice iscrizione|iscriviti|iscriversi)/ },
  { delta: -0.2, pattern: /\b(video|foto|fotografia|elaborato|saggio|disegno|racconto|ricetta|tema)\b/ },
];

/**
 * Penalità legate all'acquisto: si applicano SOLO se l'acquisto è davvero
 * richiesto. Senza questo controllo la frase "senza obbligo di acquisto"
 * conteneva "acquist" e penalizzava proprio il concorso più facile.
 */
const PURCHASE_EFFORT_PATTERNS: { delta: number; pattern: RegExp }[] = [
  { delta: -0.25, pattern: /(acquist|scontrin|spes[ae]|minimo di spesa)/ },
  { delta: -0.15, pattern: /(raccolta punti|bollini|codice|confezion)/ },
];

function participationFrom(haystack: NormalizedText): {
  participation: string | null;
  requiresPurchase: boolean;
  effort: number;
} {
  const text = haystack.lower;
  const noPurchase = NO_PURCHASE_PATTERNS.some((pattern) => pattern.test(text));
  const requiresPurchase = !noPurchase && PURCHASE_PATTERNS.some((pattern) => pattern.test(text));

  const stated =
    /(?:per partecipare|come partecipare|per concorrere|basta|è sufficiente|occorre|modalit[àa] di partecipazione)[\s:–-]+([^.\n]{12,200})/i.exec(haystack.raw);
  let participation = stated ? truncate(firstClause(stated[1]), 160) : null;
  if (!participation) {
    if (requiresPurchase) participation = "Partecipazione con acquisto (scontrino o codice prodotto).";
    else if (/\b(instagram|facebook|tiktok|social)\b/.test(text)) participation = "Partecipazione via social (post, commento o tag).";
    else if (/\b(quiz|domanda|indovinello)\b/.test(text)) participation = "Risposta a una domanda/quiz.";
    else if (/\b(iscri|registra|form|sito)\b/.test(text)) participation = "Iscrizione online con form.";
  }

  let effort = 0.5;
  for (const entry of EFFORT_PATTERNS) if (entry.pattern.test(text)) effort += entry.delta;
  if (requiresPurchase) {
    for (const entry of PURCHASE_EFFORT_PATTERNS) if (entry.pattern.test(text)) effort += entry.delta;
  } else {
    effort += 0.1;
  }
  return { participation, requiresPurchase, effort: Math.min(1, Math.max(0, Number(effort.toFixed(2)))) };
}

/**
 * Tag in un solo passaggio: una regex alternata invece di venti espressioni
 * indipendenti sullo stesso testo. L'ordine dei gruppi non conta perché ogni
 * alternativa mappa su un tag esplicito.
 */
/**
 * Le formule con cui un bando dice "si gioca ogni giorno": sono i concorsi del
 * 🎯 giro di oggi. Frasi intere e non parole sciolte ("giorno" da solo è in ogni
 * scadenza), in ASCII minuscolo: la stessa lista diventa la regex della raccolta
 * e le LIKE del riempimento dell'archivio (src/db/upgrade.ts), quindi le due
 * strade non possono dire cose diverse.
 *
 * "In palio ogni giorno" entra di proposito: è l'instant win con un premio al
 * giorno, che si gioca ogni giorno.
 */
export const DAILY_PLAY_PHRASES = [
  "ogni giorno",
  "tutti i giorni",
  "giornalmente",
  "quotidianamente",
  "volta al giorno",
  "volte al giorno",
  "giocata al giorno",
  "giocate al giorno",
  "partecipazione al giorno",
  "tentativo al giorno",
  "tentativi al giorno",
  "partecipazione giornaliera",
  "giocata giornaliera",
  "instant win giornaliero",
  "instant win giornaliera",
] as const;

/**
 * L'instant win GRATUITO è l'altro pezzo del giro, anche quando il riassunto non
 * scrive "ogni giorno": è il gioco online che si rifà a ogni visita, e il limite
 * (di solito una giocata al giorno) sta nel regolamento. Con acquisto no: lì si
 * gioca una volta per scontrino. Restano fuori quelli che si dichiarano
 * settimanali. Misurato il 19/10/2026: con le sole frasi il giro aveva 3
 * concorsi, e mancavano Loacker, Kimbo, AIA, Cupper, Suzi Wan.
 */
export const INSTANT_WIN_SPELLINGS = ["instant win", "instant-win", "instantwin"] as const;
export const WEEKLY_HINT = "settimanal";

/** Il tag dei concorsi che si giocano ogni giorno. */
export const DAILY_PLAY_TAG = "giornaliero";

const TAG_MATCHERS: { tag: string; pattern: RegExp }[] = [
  { tag: DAILY_PLAY_TAG, pattern: new RegExp(`\\b(?:${DAILY_PLAY_PHRASES.join("|")})\\b`) },
  // Premio certo: il premio è garantito a chi partecipa (non un'estrazione).
  // Misurato il 17/10/2026 sull'archivio: 25 item, 24 dei quali dalla fonte
  // dedicata di Scontrino Felice e uno da una sua scheda nei gratuiti. La
  // formula è la loro, e le altre fonti non la usano: il tag resta stretto di
  // proposito, perché "premio" da solo non vuol dire "garantito".
  {
    tag: "premio_certo",
    pattern: /\bpremi[oi]\s+cert[oi]\b|\bpremio\s+garantit[oa]\b|\bvincita\s+garantita\b|\bpremio\s+assicurato\b|\bsicuro\s+premio\b/,
  },
  { tag: "giftcard", pattern: /gift ?card|buono regalo|carta regalo|voucher/ },
  { tag: "buoni_spesa", pattern: /buoni spesa|buono spesa|spesa gratis/ },
  { tag: "contanti", pattern: /\b(contanti|cash|denaro|bonifico)\b/ },
  { tag: "viaggio", pattern: /\b(viaggio|vacanza|crociera|weekend|hotel|soggiorno)\b/ },
  { tag: "auto", pattern: /\b(auto|automobile|moto|scooter|e-?bike|bici)\b/ },
  { tag: "elettronica", pattern: /\b(iphone|ipad|macbook|smartphone|tablet|tv|televisore|smartwatch|cuffie|auricolari|pc|notebook)\b/ },
  { tag: "gaming", pattern: /\b(playstation|ps5|xbox|nintendo|console|videogioco)\b/ },
  { tag: "casa", pattern: /\b(aspirapolvere|frigorifero|lavatrice|forno|robot|cucina)\b/ },
  { tag: "food", pattern: /\b(cena|pranzo|ristorante|pizza|gelato|caff[èe]|dolc)/ },
  { tag: "moda", pattern: /\b(abbigliamento|scarpe|borsa|profumo|cosmetic|beauty)\b/ },
  { tag: "bambini", pattern: /\b(bambini|bimbi|giocattol|famiglia|scuola)\b/ },
  { tag: "sport", pattern: /\b(palestra|sport|calcio|partita|maglia|campo)\b/ },
  { tag: "carburante", pattern: /\b(carburante|benzina|rifornimento|gasolio)\b/ },
  { tag: "raccolta_punti", pattern: /raccolta punti|punti fedelt|bollini|francobolli/ },
  // "Premi da richiedere": il premio non arriva da solo, si riscatta — e la
  // richiesta ha una data sua, prima della fine del concorso. È quello che
  // distingue una raccolta punti da un'estrazione: il messaggio della watchlist
  // cambia scala per questi item (vedi RACCOLTA_REMINDER_DAYS in
  // src/telegram/digest.ts), perché a tre giorni dalla chiusura è tardi.
  // I titoli veri lo dicono così: "richiedi premi Ariete", "richiedi i premi
  // Imetec", "richiedi Buoni Amazon", "premi richiedibili entro il…".
  {
    tag: "premio_da_richiedere",
    pattern:
      /richied[ie]\w*\s+(?:i\s+|il\s+|la\s+|lo\s+|un\s+|una\s+)?(?:premi|premio|buoni|buono)|premi\s+(?:da\s+richiedere|richiedibil)|riscatt\w*\s+(?:i\s+|il\s+|la\s+)?(?:premi|premio)|premio\s+da\s+riscattare/,
  },
  { tag: "scontrino", pattern: /\b(scontrino|ticket|cassa)\b/ },
  { tag: "gratis", pattern: /gratis|gratuito|gratuita|senza acquisto|senza obbligo/ },
  { tag: "social", pattern: /\b(instagram|facebook|tiktok|social|hashtag)\b/ },
  { tag: "video", pattern: /\b(video|reel|tiktok)\b/ },
  { tag: "fotografia", pattern: /\b(foto|fotografia|immagine)\b/ },
  { tag: "punto_vendita", pattern: /\b(punto vendita|negozio|supermercato|centro commerciale|in cassa)\b/ },
];

/**
 * Trasforma ogni gruppo di cattura interno in un gruppo non catturante:
 * `(auto|bici)` diventa `(?:auto|bici)`. Serve perché in TAG_SCAN ogni tag
 * occupa esattamente UN gruppo, e la posizione del gruppo è ciò che identifica
 * il tag. Un gruppo interno lasciato di cattura sposterebbe tutti gli indici
 * successivi e farebbe restituire il tag sbagliato.
 */
function nonCapturing(pattern: RegExp): string {
  return pattern.source.replace(/\((?!\?)/g, "(?:");
}

/**
 * Regex unica costruita dalle fonti qui sopra: un solo scan del testo.
 * Se un tag non compare tra le alternative la funzione non lo restituisce mai.
 */
const TAG_SCAN = new RegExp(
  TAG_MATCHERS.map((entry) => `(${nonCapturing(entry.pattern)})`).join("|"),
  "g",
);

/**
 * Il regalo che si riceve comprando. Sono le formule delle pagine vere:
 * "in regalo", "in omaggio", "richiedi il set tagliere", "ricevi il peluche",
 * "ritira l'astuccio". Il vocabolario degli oggetti è quello misurato sulle
 * pagine (17/10/2026): senza, "richiedi un buono" da solo confonderebbe il
 * rimborso con l'omaggio, e il rimborso non è un regalo.
 */
const GIFT_WORDS = /\b(in regalo|in omaggio|omaggi[oaie]|premio\s+omaggio)\b/;
const GIFT_VERB_OBJECT =
  /\b(richied[ie]|richiedere|ricevi|ricevere|ritira|ritirare)\b[^.]{0,60}\b(set|kit|astuccio|teglia|calici|secchiello|borsa|bowl|ciotola|peluche|gadget|speaker|zaino|tagliere|piatti|insalatiera|tazza|borraccia|maglietta|cappellino|voucher|buono|gift ?card)\b/;
/** Le parole che dicono "paghi meno", non "ricevi un regalo". */
const NOT_A_GIFT = /\b(rimborso|cashback|buono sconto|coupon)\b/;
/**
 * Un'estrazione, non un premio garantito. Serve solo alle raccolte punti: una
 * raccolta punti è la forma più comune di omaggio con acquisto (bollini → set di
 * piatti), ma la stessa pagina può annunciare anche un'estrazione fra chi
 * colleziona. In quel caso non è più "il premio è tuo".
 */
const DRAW_SIGNAL = /\b(vinci|vincere|in palio|estrazione|instant ?win|gratta e vinci)\b/;

export interface ContentClassInput {
  /** Testo già normalizzato (normalizeForExtraction). */
  haystack: NormalizedText;
  /**
   * Tag già noti: quelli della fonte e quelli letti dal testo. "premio_certo"
   * può arrivare da entrambi, e l'omaggio lo guarda per decidere.
   */
  tags: readonly string[];
  requiresPurchase: boolean;
}

/**
 * I tag di "contenuto di prima classe": premio certo e omaggio con acquisto.
 *
 * Sono due domande diverse sullo stesso item — "il premio me lo danno di
 * sicuro?" e "che cosa ricevo comprando?" — e per questo si sovrappongono: nei
 * dati di oggi 20 dei 21 omaggi sono anche premi certi (misura del 17/10/2026).
 * Il tag dell'omaggio è DERIVATO: serve una spesa, e il testo deve dire che
 * cosa si riceve (un oggetto, un voucher) oppure che il premio è certo. Un
 * concorso con acquisto che estrae a sorte non è un omaggio, e un rimborso non
 * è un regalo: entrambi restano fuori.
 */
export function contentClassTags(input: ContentClassInput): string[] {
  const found: string[] = [];
  const tags = new Set(input.tags);
  if (tags.has("premio_certo")) found.push("premio_certo");
  const text = input.haystack.lower;
  if (
    !input.requiresPurchase &&
    !tags.has(DAILY_PLAY_TAG) &&
    INSTANT_WIN_SPELLINGS.some((grafia) => text.includes(grafia)) &&
    !text.includes(WEEKLY_HINT)
  ) {
    found.push(DAILY_PLAY_TAG);
  }
  if (!input.requiresPurchase) return found;
  if (tags.has("coupon") || NOT_A_GIFT.test(text)) return found;
  const regalo = GIFT_WORDS.test(text) || GIFT_VERB_OBJECT.test(text) || tags.has("premio_certo");
  // Una raccolta punti con acquisto È un omaggio con acquisto: si compra per
  // collezionare, e il premio si ritira. Resta fuori quando la pagina promette
  // anche un'estrazione ("colleziona e vinci"): lì il premio non è più certo.
  const raccolta = tags.has("raccolta_punti") && !DRAW_SIGNAL.test(text);
  if (regalo || raccolta) found.push("omaggio_con_acquisto");
  return found;
}

/**
 * La stessa cosa partendo dal testo grezzo: è l'ingresso del riempimento
 * dell'archivio, che non ha un testo già normalizzato da riusare.
 */
export function contentClassTagsFor(
  text: string,
  options: { tags?: readonly string[]; requiresPurchase: boolean },
): string[] {
  const haystack = normalizeForExtraction(text);
  const tags = [...(options.tags ?? []), ...tagsFrom(haystack)];
  return contentClassTags({ haystack, tags, requiresPurchase: options.requiresPurchase });
}

function tagsFrom(haystack: NormalizedText): string[] {
  const found = new Set<string>();
  TAG_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_SCAN.exec(haystack.lower)) !== null) {
    const groupIndex = match.slice(1).findIndex((group) => group !== undefined);
    const matcher = TAG_MATCHERS[groupIndex];
    if (matcher) found.add(matcher.tag);
    if (match.index === TAG_SCAN.lastIndex) TAG_SCAN.lastIndex++;
    if (found.size === TAG_MATCHERS.length) break;
  }
  return [...found];
}

/**
 * Segnali che il testo parli davvero di un concorso a premi.
 * \b evita che "Premium" passi per "premi": è il caso reale che ha portato
 * a filtrare le notizie di Google News che non c'entrano nulla.
 */
const CONTEST_SIGNAL =
  /(concors|in palio|vinci\b|vincita|vincono|vincer[aà]|premio\b|premi\b|estrazion|scontrin|raccolta punti|instant ?win|gift ?card|buon[oi] spesa|omaggi|partecipa)/i;

export function looksLikeContest(titleOrText: string): boolean {
  return CONTEST_SIGNAL.test(titleOrText);
}

/**
 * Il filtro di pertinenza di 📰 News.
 *
 * `looksLikeContest` basta per una pagina di elenco, dove "in palio" vuol dire
 * un premio da riscuotere; su un articolo di giornale no. Il 17/10/2026 la
 * sezione era piena di cose che con i concorsi non c'entrano: le estrazioni del
 * SuperEnalotto e dell'Eurojackpot (gioco d'azzardo, non concorsi a premi), le
 * gare sportive ("in palio i titoli regionali", "in palio i primi pass"), i
 * premi professionali ("candidature per cronisti", "borse di studio") e perfino
 * il titolo di un episodio TV ("Ep. 22 - Il concorso Video"). Chi tocca quei
 * titoli si aspetta un concorso e finisce su un sito che non c'entra.
 *
 * Le tre classi di rumore sono trattate diversamente di proposito:
 *  - il gioco d'azzardo e i risultati ("ha vinto", "numeri vincenti") sono
 *    fuori SEMPRE: non c'è niente da partecipare, anche se la frase contiene
 *    "concorso" o "vincita";
 *  - lo sport e i premi professionali scartano solo se l'articolo non parla
 *    anche di un concorso da consumatore: "Concorso Barilla: in palio biglietti
 *    per la partita" è un concorso vero, e la parola "partita" non basta a
 *    buttarlo via.
 */
// `\b…\b` su ogni alternativa: senza, "Premium" della PlayStation Plus passava
// per "premi" — è il caso che il test delle fonti news aveva già in casa.
const NEWS_TOPIC =
  /\b(concors\w*|in palio|vinc\w*|premi|premio|estrazion\w*|gift ?card|buon[oi][\s-](?:spesa|regalo|sconto)|voucher|coupon|codice[\s-]sconto|rimborso|cashback|raccolta punti|scontrino|instant ?win|omaggi\w*|partecipa\w*|promozion\w*|offert[ae]|scont[oi])\b/i;

const NEWS_ALWAYS_OFF = [
  // Gioco d'azzardo: si gioca, non si partecipa.
  /\b(superenalotto|super enalotto|10e ?lotto|eurojackpot|jackpot|gratta e vinci|lotteria|lotterie|numeri vincenti|vincite? al lotto)\b/i,
  // Risultati: chi ha vinto ha già vinto, e la notizia non è un'occasione.
  /\b(ha vinto|hanno vinto|vincita da|vincite da|vincitori|vincitrice)\b/i,
  // Premi professionali, bandi e scuola. `award`/`prize` sono le stesse cose
  // scritte in inglese: "World Sports Photography Awards" è un premio per
  // fotografi sportivi, non un concorso da supermercato.
  /\b(bors[ae] di studio|premio (?:giornalistic\w*|letterari\w*|nazional\w*|internazional\w*)|awards?|prizes?|candidatur\w*|scuol\w*|student\w*|universit\w*|terzo settore|firmacopie)\b/i,
  // TV e spettacolo: il "concorso" di una serie non è un concorso.
  /\b(ep\.?\s*\d+|episodio|puntata)\b/i,
];

const NEWS_SPORT =
  /\b(campionat\w*|torneo|trofeo|mondial\w*|olimpiad\w*|olimpic\w*|finali? nazional\w*|qualificazion\w*|tricolori|coppa (?:italia|del mondo|europa)|serie [ab]\b|enduro|motocross|rally|calcio|basket|volley|atleti|atleta|ginnastica|nuoto|ciclismo|pallavolo|pallacanestro|sports?|football|soccer|tennis|golf)/i;

/** Le parole che dicono "c'è un premio da consumatore", non una gara. */
const NEWS_CONSUMER =
  /\b(concors\w*|gift ?card|buon[oi][\s-](?:spesa|regalo|sconto)|coupon|codice[\s-]sconto|rimborso|cashback|raccolta punti|scontrino|instant ?win)\b/i;

export function looksLikeNewsContest(titleOrText: string): boolean {
  if (!NEWS_TOPIC.test(titleOrText)) return false;
  if (NEWS_ALWAYS_OFF.some((pattern) => pattern.test(titleOrText))) return false;
  if (NEWS_SPORT.test(titleOrText) && !NEWS_CONSUMER.test(titleOrText)) return false;
  return true;
}

/**
 * Segnale di concorso per le fonti di elenco, dove il "testo" è lo slug di un
 * URL: `vincibici` e `premia-te-e-lambiente` sono concorsi, `tazze-creeper` no.
 * È volutamente più largo di CONTEST_SIGNAL ("vinc" invece di "vinci\b", "prem"
 * invece di "premio\b") perché nell'URL le parole sono troncate e attaccate.
 */
const LISTING_SIGNAL =
  /(concors|vinc|palio|premi\b|premia|premio|estrazion[ei]|gioca|partecipa|scontrin|instant ?win|gift ?card|omaggi)/i;

export function looksLikeListingContest(urlOrTitle: string): boolean {
  return LISTING_SIGNAL.test(urlOrTitle);
}

// --- API pubblica: comoda sui testi singoli, condivisa nel percorso caldo ---

export function extractDeadline(text: string, now: Date): string | null {
  return deadlineFrom(normalizeForExtraction(text), now);
}

export function extractPrize(text: string): { prize: string | null; prizeValue: number } {
  return prizeFrom(normalizeForExtraction(text));
}

export function extractParticipation(text: string): {
  participation: string | null;
  requiresPurchase: boolean;
  effort: number;
} {
  return participationFrom(normalizeForExtraction(text));
}

export function extractTags(text: string): string[] {
  return tagsFrom(normalizeForExtraction(text));
}

/**
 * Arricchimento completo di un item grezzo.
 * Normalizza una volta sola e riusa lo stesso testo per tutti gli estrattori:
 * su 25 item per esecuzione la differenza si vede nel budget di CPU.
 */
export function enrichWithRules(item: RawItem, source: { tags: string[] }, now: Date): Insight {
  const haystack = normalizeForExtraction(`${item.title}\n${item.summary}`);
  const deadline = deadlineFrom(haystack, now);
  const { prize, prizeValue } = prizeFrom(haystack);
  const { participation, requiresPurchase, effort } = participationFrom(haystack);
  const tags = [...new Set([...source.tags, ...tagsFrom(haystack)])];
  if (requiresPurchase && !tags.includes("acquisto")) tags.push("acquisto");
  // I due tag di contenuto nascono qui, con la stessa funzione che usa il
  // riempimento dell'archivio (scripts/backfill-tags.ts): una definizione sola.
  for (const tag of contentClassTags({ haystack, tags, requiresPurchase })) {
    if (!tags.includes(tag)) tags.push(tag);
  }

  return { deadline, prize, participation, prizeValue, effort, requiresPurchase, tags, aiUsed: false };
}
