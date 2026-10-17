import { extractDeadline, normalizeForExtraction, type NormalizedText } from "./rules.ts";

/**
 * Cosa mettere da parte e quando chiedere il premio.
 *
 * Perché esiste: la scheda di un concorso racconta come si partecipa, ma le due
 * cose che si pagano care se si dimenticano sono altre — la prova d'acquisto da
 * conservare e la finestra per richiedere il premio, che nei bandi è PRIMA della
 * chiusura del concorso. Finora le diceva solo il promemoria della watchlist,
 * cioè solo per chi aveva salvato l'item e solo quando mancavano pochi giorni;
 * qui diventano due righe che restano sulla scheda.
 *
 * Perché si calcola al momento della scheda e non all'ingestione: la scheda
 * mostra UN item per volta, quindi il costo è una manciata di regex, e le righe
 * valgono subito anche per l'archivio già raccolto — niente colonna nuova,
 * niente migrazione, niente comando di riempimento.
 *
 * Regola dichiarata: non si inventa niente. Quando il testo non nomina la
 * prova, la riga o è generica ma vera (raccolte e concorsi con acquisto) o non
 * c'è; quando non dice quando richiedere il premio, la scheda non mette una
 * data, e al massimo dice dove cercarla.
 */

/** La finestra per richiedere il premio: una data, oppure N giorni da un evento. */
export type ClaimWindow =
  | { kind: "date"; date: string }
  | { kind: "days"; days: number; from: string | null };

export interface ItemDuty {
  /** Cosa conservare, in parole brevi; null se il testo non lo dice. */
  keep: string | null;
  claim: ClaimWindow | null;
}

/** Quello che serve per le due righe: il testo, più i segnali già calcolati. */
export interface DutyInput {
  title: string;
  summary: string;
  /** Dal punteggio: dice se l'acquisto serve davvero. */
  requiresPurchase?: boolean;
  /** Tag dell'item: raccolta punti e premio da richiedere hanno una prova loro. */
  tags?: string[];
}

interface KeepMatcher {
  /** Due espressioni dello stesso gruppo non si sommano ("scontrino"+"scontrino originale"). */
  group: string;
  what: string;
  pattern: RegExp;
}

/**
 * Le prove che i bandi chiedono di mettere da parte, dalla più utile alla meno.
 * Il primo posto è la prova d'acquisto generica: quando c'è, le altre sono sue
 * varianti e la riga non deve elencarle tutte.
 */
const KEEP_MATCHERS: KeepMatcher[] = [
  { group: "prova", what: "la prova d'acquisto", pattern: /\bprova\s+d['’]acquisto/ },
  {
    group: "scontrino",
    what: "lo scontrino originale",
    pattern: /\bscontrin\w*\s+(?:originale|cartaceo|parlante|fiscale)\b/,
  },
  { group: "scontrino", what: "lo scontrino", pattern: /\bscontrin\w*/ },
  {
    group: "codice",
    what: "il codice sotto il tappo",
    pattern: /\bcodice\s+(?:alfanumerico\s+)?(?:univoco\s+)?(?:sotto\s+il\s+tappo|dentro\s+il\s+tappo|sul\s+tappo)/,
  },
  {
    group: "codice",
    what: "il codice sulla confezione",
    pattern:
      /\bcodice\s+(?:alfanumerico\s+)?(?:univoco\s+)?(?:sulla|sul|dentro|all'interno\s+della|presente\s+(?:sulla|sul)|della)\s+(?:confezione|confezion|retro|scatola)/,
  },
  {
    group: "codice",
    what: "il codice sull'etichetta",
    pattern: /\bcodice\s+(?:alfanumerico\s+)?(?:univoco\s+)?(?:sull'etichetta|sulla\s+etichetta)/,
  },
  {
    group: "codice",
    what: "il codice del prodotto",
    pattern: /\bcodice\s+(?:promozionale|univoco|alfanumerico)\b/,
  },
  { group: "bollini", what: "i bollini", pattern: /\bbollin\w*/ },
  { group: "francobolli", what: "i francobolli", pattern: /\bfrancoboll\w*/ },
  // Stesso gruppo dei bollini: "bollini e punti della raccolta" sono la stessa
  // cosa detta due volte, e in scheda diventerebbe una ripetizione.
  { group: "bollini", what: "i punti della raccolta", pattern: /\braccolta\s+punti\b|\bpunti\s+fedelt/ },
  // Confezione, tappi ed etichette valgono solo se il testo dice di metterli da
  // parte: "acquista 3 confezioni" è un requisito d'acquisto, non una prova da
  // conservare, e dirgli di tenere la confezione sarebbe un consiglio sbagliato.
  {
    group: "confezione",
    what: "la confezione",
    pattern:
      /(?:\bconserva\w*|\bcustodisci\w*|\btenere\b|\ballegare\b|\binviare\b|\bspedire\b|\britagli\w*)[^.]{0,60}\bconfezion\w*|\bconfezion\w*[^.]{0,40}\b(?:va\s+conservat\w*|da\s+conservare|da\s+allegare|da\s+inviare|da\s+spedire)/,
  },
  {
    group: "tappo",
    what: "i tappi",
    pattern:
      /(?:\bconserva\w*|\braccogli\w*|\bmetti\w*\s+da\s+parte)[^.]{0,60}\btapp[oi]\b|\btapp[oi]\b[^.]{0,40}\b(?:da\s+conservare|da\s+raccogliere|va\s+conservat\w*)/,
  },
  {
    group: "etichetta",
    what: "l'etichetta",
    pattern:
      /(?:\bconserva\w*|\bcustodisci\w*|\britagli\w*|\bstacc\w*)[^.]{0,60}\betichett\w*|\betichett\w*[^.]{0,40}\bda\s+conservare/,
  },
];

/**
 * Frasi che dicono che non c'è niente da conservare. Senza questa guardia un
 * "concorso senza obbligo di acquisto, nessuno scontrino" mostrerebbe proprio
 * la riga "conserva lo scontrino".
 */
const NO_PROOF =
  /\b(?:senza\s+(?:alcun\s+)?(?:obbligo\s+di\s+)?(?:acquisto|scontrino)|nessun[oa]?\s+scontrino|non\s+serve\s+(?:lo\s+|la\s+)?scontrino|non\s+(?:è|e')\s+richiest[oa]\s+(?:alcun\s+)?acquisto|senza\s+spendere(?:\s+niente)?|concorso\s+gratuit[oi]|gratuitamente|gratis)\b/;

/** Parole che dicono che non si compra niente: lì la prova d'acquisto non serve. */
const FREE_MARKERS = /\b(gratuit[oi]|gratuitamente|gratis|senza\s+acquisto|senza\s+obbligo|senza\s+spendere)\b/;

function joinProofs(items: string[]): string {
  if (items.length === 1) return items[0]!;
  return `${items[0]} e ${items[1]}`;
}

/**
 * Cosa conservare, al massimo due cose: "lo scontrino originale e il codice
 * sulla confezione". Ogni gruppo compare una volta sola; quando il testo non
 * nomina nessuna prova, non c'è niente da mostrare.
 */
function keepFromNormalized(haystack: NormalizedText): string | null {
  const lower = haystack.lower;
  if (NO_PROOF.test(lower)) return null;
  // Nessuna prova da conservare in un concorso che si dichiara gratuito: lì la
  // "confezione" nominata è il premio ("kit da 3 confezioni"), non la prova.
  if (FREE_MARKERS.test(lower)) return null;

  const trovati: string[] = [];
  const gruppi = new Set<string>();
  for (const matcher of KEEP_MATCHERS) {
    if (gruppi.has(matcher.group)) continue;
    if (!matcher.pattern.test(lower)) continue;
    gruppi.add(matcher.group);
    trovati.push(matcher.what);
    if (trovati.length === 2) break;
  }
  return trovati.length === 0 ? null : joinProofs(trovati);
}

export function keepFrom(text: string): string | null {
  return keepFromNormalized(normalizeForExtraction(text));
}

/** Verbi con cui un bando dice che il premio va chiesto, non solo vinto. */
const CLAIM_TRIGGER = /\b(richied\w*|richiest\w*|riscatt\w*|ritir\w*|ritirat\w*|reclam\w*)\b/;
/** Il complemento oggetto: senza, "richiedi il codice sconto" non è un premio. */
const CLAIM_OBJECT = /\b(premio|premi|vincit[ae]|vittori[ae]|buon[oi]|voucher|gift ?card|regalo|omaggio|risarcimento)\b/;
/** Una frase che parla di partecipazione non è una frase sul premio. */
const PARTICIPATION_ONLY = /\b(partecipa\w*|iscri\w*|registra\w*|acquista\w*|spedisci\w*|invia\w*)\b/;

/** Frasi del testo: la punteggiatura chiude una frase solo se seguita da spazio. */
function sentences(raw: string): string[] {
  return raw
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((frase) => frase.trim())
    .filter((frase) => frase.length > 0);
}

/**
 * Dopo "entro 30 giorni" c'è spesso da cosa decorrono: "dalla comunicazione
 * della vincita", "dall'estrazione". Si tengono le prime parole, perché il resto
 * della frase è contorno.
 */
function fromEvent(frase: string, start: number): string | null {
  const tail = frase.slice(start);
  // Due forme, perché l'apostrofo non ha lo spazio che hanno le altre:
  // "dall'estrazione" sta attaccato, "dalla comunicazione" no.
  const apostrofo = /^\s*(dall['’])\s*([^.;,]{3,48})/i.exec(tail);
  const staccato = /^\s*(dalla|dalle|dagli|dai|dal)\s+([^.;,]{3,48})/i.exec(tail);
  const match = apostrofo ?? staccato;
  if (!match) return null;
  const preposizione = (match[1] ?? "").toLowerCase().replace("’", "'");
  const parole = (match[2] ?? "").trim().split(/\s+/).slice(0, 4);
  // Le parole di raccordo in fondo ("dalla data della…") non aggiungono niente.
  while (parole.length > 0 && /^(?:e|o|per|che|con|in|a|al|alla|della|del|dei|di|dai|dalle)$/i.test(parole[parole.length - 1]!)) {
    parole.pop();
  }
  const resto = parole.join(" ").trim();
  if (resto.length === 0) return null;
  return `${preposizione}${preposizione.endsWith("'") ? "" : " "}${resto}`;
}

/**
 * Quando il premio va richiesto.
 *
 * Solo una frase che parla del premio E di una richiesta può dire qualcosa: la
 * scadenza del concorso ("partecipa entro il…") non è la scadenza della
 * richiesta, e confonderle manderebbe a chiedere il premio quando invece si può
 * ancora partecipare. Prima la data vera (riusando l'estrattore della scadenza
 * della regola, che sa già leggere "entro il 31/12/2026"), poi il conto in
 * giorni ("entro 30 giorni dalla comunicazione").
 */
function claimFromNormalized(haystack: NormalizedText, now: Date): ClaimWindow | null {
  for (const frase of sentences(haystack.raw)) {
    const lower = frase.toLowerCase();
    if (!CLAIM_TRIGGER.test(lower) || !CLAIM_OBJECT.test(lower)) continue;
    if (PARTICIPATION_ONLY.test(lower) && !/\b(premio|premi)\b/.test(lower)) continue;

    const date = extractDeadline(frase, now);
    if (date) return { kind: "date", date };

    const giorni = /\bentro\s+(?:e\s+non\s+oltre\s+)?(?:un\s+massimo\s+di\s+|massimo\s+)?(\d{1,3})\s+giorn[oi]\b/.exec(lower);
    if (giorni) {
      const giorniNumero = Number(giorni[1]);
      if (Number.isInteger(giorniNumero) && giorniNumero > 0) {
        return { kind: "days", days: giorniNumero, from: fromEvent(frase, giorni.index + giorni[0].length) };
      }
    }
  }
  return null;
}

/** Le parole che rendono una raccolta una raccolta: senza, il tag da solo inganna. */
const RACCOLTA_WORDS = /\b(bollin\w*|punt[oi]\b|francoboll\w*)/;

/**
 * Quando il testo non nomina la prova ma la prova c'è per forza: una raccolta
 * punti si fa con bollini e scontrini, un concorso con acquisto si reclama con
 * la prova d'acquisto. Meglio una riga generica e vera che il silenzio.
 *
 * Niente riga, invece, quando il testo dice "gratuito" o "senza acquisto": lì
 * il segnale del punteggio può sbagliare, e un consiglio sbagliato costa più di
 * una riga mancante (misurato sull'archivio: concorsi con acquisto senza una
 * prova nominata, alcuni dei quali si dichiarano gratuiti, come il Giveaway
 * Marionnaud che chiede solo la carta fedeltà gratuita).
 */
function fallbackKeep(item: DutyInput, lower: string): string | null {
  if (FREE_MARKERS.test(lower)) return null;
  const raccolta = (item.tags ?? []).includes("raccolta_punti");
  if (raccolta && RACCOLTA_WORDS.test(lower)) return "gli scontrini e i bollini";
  if (item.requiresPurchase) return "lo scontrino o la prova d'acquisto";
  if (raccolta) return "gli scontrini e i bollini";
  return null;
}

export function claimFrom(text: string, now: Date): ClaimWindow | null {
  return claimFromNormalized(normalizeForExtraction(text), now);
}

/**
 * Le due informazioni della scheda: dal testo, con i segnali dell'item come
 * riserva. Il testo si normalizza UNA volta sola: la scheda si disegna su ogni
 * tocco e su ogni avviso, e tre passate sullo stesso testo sono due di troppo.
 */
export function dutiesFor(item: DutyInput, now: Date): ItemDuty {
  const haystack = normalizeForExtraction(`${item.title}\n${item.summary}`);
  const keep = keepFromNormalized(haystack) ?? fallbackKeep(item, haystack.lower);
  return { keep, claim: claimFromNormalized(haystack, now) };
}
