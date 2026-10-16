/**
 * Helper deterministici di normalizzazione testo/URL.
 * Nessuna dipendenza esterna: gira identico su Workers e su Node (test).
 */

const IT_STOPWORDS = new Set([
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "del", "della", "dei", "degli",
  "delle", "da", "dal", "dalla", "dai", "dalle", "in", "nel", "nella", "nei", "nelle", "con",
  "su", "sul", "sulla", "per", "tra", "fra", "e", "ed", "o", "od", "a", "ad", "al", "alla",
  "ai", "alle", "che", "chi", "cui", "non", "the", "of", "and", "to", "for", "your", "my",
]);

/** Parametri di tracciamento da rimuovere sempre: non cambiano la pagina, ma la chiave sì. */
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "igshid", "_ga", "ref", "source", "spm", "yclid", "twclid", "ttclid"]);
const TRACKING_PREFIXES = ["utm_", "oly_", "s_kwcid"];

export function stripDiacritics(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Entità HTML nominali frequenti nei feed italiani (euro in testa).
 * Le numeriche (&#8364;) sono gestite sopra a prescindere da questa mappa.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">", amp: "&",
  euro: "€", pound: "£", dollar: "$", cent: "¢", yen: "¥",
  hellip: "…", ndash: "–", mdash: "—", minus: "−",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  laquo: "«", raquo: "»", bull: "•", middot: "·", dagger: "†", permil: "‰",
  copy: "©", reg: "®", trade: "™", deg: "°", micro: "µ", plusmn: "±",
  times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾",
  sup2: "²", sup3: "³", para: "¶", sect: "§", not: "¬", shy: "\u00ad",
  agrave: "à", egrave: "è", eacute: "é", igrave: "ì", ograve: "ò", ugrave: "ù",
  Agrave: "À", Egrave: "È", Eacute: "É", Igrave: "Ì", Ograve: "Ò", Ugrave: "Ù",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  ccedil: "ç", Ccedil: "Ç", ntilde: "ñ", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú",
};

/** Decodifica le entità HTML più comuni (nominali e numeriche). */
export function decodeEntities(input: string): string {
  // Il 90% dei testi non contiene entità: un solo indexOf evita quattro regex.
  if (!input.includes("&")) return input.replace(/\s+/g, " ").trim();
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,7});/g, (match, name: string) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Toglie tag e script, decodifica le entità e comprime gli spazi. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Boilerplate degli aggregatori: "[…] Leggi l'articolo: …", "Continua a leggere",
 * "L'articolo … proviene da …". Se resta nel testo, finisce dentro il campo
 * premio e sporca il messaggio.
 */
const BOILERPLATE_MARKERS: RegExp[] = [
  /\s*\[\s*(…|\.\.\.)\s*\]/g,
  /\s*leggi l'articolo:?[\s\S]*$/i,
  /\s*continua a leggere[\s\S]*$/i,
  /\s*l'articolo [\s\S]{0,140}? proviene da[\s\S]*$/i,
  /\s*the post [\s\S]*? appeared first on[\s\S]*$/i,
  /\s*fonte:\s*[\s\S]*$/i,
];

const BOILERPLATE_HINT = /\[|leggi l'articolo|continua a leggere|proviene da|appeared first on|fonte:/i;

export function stripBoilerplate(input: string): string {
  // Solo i testi che contengono davvero un marcatore pagano le sei regex.
  if (!BOILERPLATE_HINT.test(input)) return input;
  let output = input;
  for (const marker of BOILERPLATE_MARKERS) output = output.replace(marker, " ");
  return output.replace(/\s+/g, " ").trim();
}

export function truncate(input: string, max: number): string {
  const clean = input.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * URL canonico: host minuscolo senza www, hash rimosso, parametri di tracking
 * rimossi, parametri rimasti ordinati, slash finale rimosso.
 */
export function canonicalUrl(raw: string, base?: string): string {
  const cleaned = decodeEntities(raw).trim();
  let url: URL;
  try {
    // Senza base NON inventiamo un dominio: un URL non assoluto resta com'è,
    // altrimenti diventa una pagina fantasma su un host che non esiste.
    url = base ? new URL(cleaned, base) : new URL(cleaned);
  } catch {
    return cleaned;
  }
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.searchParams.sort();
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path === "" ? "/" : path;
  return url.toString();
}

/**
 * Chiave stabile e corta per un URL canonico.
 *
 * Non è una funzione crittografica e non deve esserlo: serve a riconoscere lo
 * stesso URL, quindi 64 bit da due flussi FNV-1a bastano (collisioni
 * trascurabili a queste scale). Costa una frazione di crypto.subtle.digest, che
 * per ogni item aggiungeva una chiamata nativa asincrona — misurata come uno
 * dei costi per item più alti rispetto al budget di CPU del piano Free.
 */
export function urlKey(canonical: string): string {
  const first = fnv1a32(canonical);
  const second = fnv1a32(`${canonical}#k`);
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

/** Titolo normalizzato: minuscole, senza diacritici, senza stopword, cifre uniformate. */
export function normalizeTitle(title: string): string {
  const lowered = stripDiacritics(decodeEntities(title)).toLowerCase();
  const digits = lowered.replace(/(\d)[.,](\d{3})/g, "$1$2");
  const cleaned = digits.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned
    .split(" ")
    .filter((t) => (t.length >= 3 || /^\d+$/.test(t)) && !IT_STOPWORDS.has(t))
    .join(" ");
}

export function tokens(input: string): string[] {
  const normalized = normalizeTitle(input);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** FNV-1a a 32 bit: deterministico, sincrono, senza dipendenze. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const SIMHASH_BITS = 64;
const SIMHASH_HALF = 32;

function shingles(input: string): string[] {
  return tokens(input);
}

/**
 * SimHash a 64 bit sugli unigrammi del titolo, restituito come 16 caratteri hex.
 * Titoli dello stesso concorso ripresi da fonti diverse finiscono a distanza di
 * Hamming piccola: è la base della deduplica cross-fonte.
 *
 * Solo unigrammi e al più MAX_SHINGLES termini: la decisione finale la prende
 * isDuplicateTitle, quindi questo è un prefilter economico e non serve che sia
 * fine. I bigrammi costavano il doppio senza cambiare l'esito.
 */
const MAX_SHINGLES = 24;

export function simhash(text: string): string {
  const vector = new Int32Array(SIMHASH_BITS);
  const seen = new Set<string>();
  for (const gram of shingles(text)) {
    if (seen.size >= MAX_SHINGLES) break;
    if (seen.has(gram)) continue;
    seen.add(gram);
    const h1 = fnv1a32(gram);
    const h2 = fnv1a32(`${gram}#1`);
    for (let bit = 0; bit < SIMHASH_HALF; bit++) {
      vector[bit] += (h1 >>> bit) & 1 ? 1 : -1;
      vector[SIMHASH_HALF + bit] += (h2 >>> bit) & 1 ? 1 : -1;
    }
  }
  let low = 0;
  let high = 0;
  for (let bit = 0; bit < SIMHASH_HALF; bit++) {
    if (vector[bit] > 0) low = (low | (1 << bit)) >>> 0;
    if (vector[SIMHASH_HALF + bit] > 0) high = (high | (1 << bit)) >>> 0;
  }
  return `${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
}

function popcount32(value: number): number {
  let v = value >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Distanza di Hamming tra due simhash esadecimali. */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length || a.length === 0) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i += 8) {
    const left = parseInt(a.slice(i, i + 8), 16);
    const right = parseInt(b.slice(i, i + 8), 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return Number.MAX_SAFE_INTEGER;
    distance += popcount32((left ^ right) >>> 0);
  }
  return distance;
}

/**
 * Parole che compaiono in quasi tutti i titoli di concorso: non identificano
 * nulla, quindi non devono contare quando si confrontano due titoli.
 */
const CONTEST_GENERIC = new Set([
  "vinci", "vincere", "vinciamo", "concorso", "concorsi", "concorsone", "premio", "premi",
  "palio", "parziale", "buono", "buoni", "spesa", "spese", "euro", "gratis", "gratuito",
  "gratuita", "gratuitamente", "partecipare", "partecipazione", "parteciperai", "nuovo",
  "nuova", "nuovi", "nuove", "scontrino", "scontrini", "acquisto", "acquistare", "acquista",
  "raccolta", "punti", "come", "cosa", "sito", "ufficiale", "promozione", "promozioni",
  "iniziativa", "operazione", "regolamento", "online", "dettagli", "ecco", "subito", "oggi",
  "scade", "scadenza", "scadono", "termine", "entro", "valido", "valida", "partecipa",
  "iscrizione", "iscriversi", "registrati", "vincita", "montepremi",
]);

/** Token che identificano davvero un concorso (brand, premio, città…). */
export function distinctiveTokens(input: string): string[] {
  return tokens(input).filter((token) => !CONTEST_GENERIC.has(token) && !/^\d+$/.test(token));
}

/** Importi e numeri presenti nel titolo, ordinati. */
export function numbersOf(input: string): string[] {
  return tokens(input)
    .filter((token) => /^\d+$/.test(token))
    .sort();
}

/**
 * Soglia di candidato per il prefilter SimHash: larga di proposito, la
 * decisione finale la prende isDuplicateTitle.
 *
 * Misurato su coppie reali italiane: i duplicati veri stanno a Hamming 10-20,
 * ma concorsi diversi arrivano fino a 8 — quindi il solo SimHash NON separa e
 * va usato come prefilter, mai come giudice. La soglia è volutamente larga:
 * un titolo che porta anche la scadenza sta più lontano, e scartarlo qui
 * significherebbe perdere il duplicato prima ancora di valutarlo.
 */
export const DUP_CANDIDATE_MAX_HAMMING = 32;

/** Somiglianza minima sui token distintivi per parlare di duplicato. */
export const DUP_MIN_JACCARD = 0.6;

/**
 * Decide se due titoli descrivono lo stesso concorso.
 * Regola calibrata sui dati: token distintivi simili (Jaccard ≥ 0.6) e nessuna
 * discordanza sugli importi ("1000 euro" ≠ "500 euro" → concorsi diversi).
 * Se un titolo non contiene numeri, il confronto numerico non si applica.
 */
export function isDuplicateTitle(titleA: string, titleB: string): boolean {
  const left = distinctiveTokens(titleA);
  const right = distinctiveTokens(titleB);

  const leftNumbers = numbersOf(titleA);
  const rightNumbers = numbersOf(titleB);
  if (leftNumbers.length > 0 && rightNumbers.length > 0 && leftNumbers.join(",") !== rightNumbers.join(",")) {
    return false;
  }

  if (left.length === 0 && right.length === 0) {
    // Titoli fatti solo di parole generiche: vale solo l'uguaglianza esatta.
    return normalizeTitle(titleA) === normalizeTitle(titleB) && normalizeTitle(titleA).length > 0;
  }

  return jaccard(left, right) >= DUP_MIN_JACCARD;
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Toglie dal titolo le parole che compongono il nome della fonte: gli
 * aggregatori antepongono il proprio nome ("Scontrino Felice - Concorso…") e
 * quel token estraneo abbasserebbe la similarità con lo stesso concorso visto
 * altrove. Se il titolo resterebbe troppo corto, si tiene l'originale.
 */
export function sourceNameTokens(sourceName: string): Set<string> {
  return new Set(tokens(sourceName));
}

/** Chiave grezza di una parola: minuscola, senza diacritici né punteggiatura. */
function wordKey(word: string): string {
  return stripDiacritics(word).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function stripSourceTokens(title: string, sourceName: string | Set<string>): string {
  const unwanted = typeof sourceName === "string" ? sourceNameTokens(sourceName) : sourceName;
  if (unwanted.size === 0) return title.trim();

  const cleaned = title
    .split(/\s+/)
    .filter((word) => {
      const key = wordKey(word);
      return key.length === 0 || !unwanted.has(key);
    })
    .join(" ")
    .replace(/^[\s\-–—:|·.]+/, "")
    .replace(/[\s\-–—:|·.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length >= 8 ? cleaned : title.trim();
}

export function slugify(input: string): string {
  return stripDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
