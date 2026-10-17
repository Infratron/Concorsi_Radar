import type { ItemRow, NavPoint, Prefs, RefundRow, RefundTotals, RunRow, SourceRow, UiState } from "../types.ts";
import { formatEuro, refundAmountLabel } from "../refunds.ts";
import { brandLabel, type BrandChoice } from "../config/brands.ts";
import { GRUPPI_DIAGNOSI, type Diagnosi, type RiepilogoDiagnosi } from "../sources-health.ts";
import {
  CATEGORY_LABELS,
  PRIZE_QUICK_FILTERS,
  archivioKindFor,
  isSeeingAll,
  mutedSourceIds,
  onlyFavoriteBrands,
  prizeFilterFor,
  type FilterSource,
} from "../filters.ts";
import type { LeadStats } from "../enrich/lead.ts";
import { explainScore, insightFromRow } from "../enrich/score.ts";
import { HELP_PAGES, helpIndexFor, helpPageForSection } from "./help.ts";
import { MAX_MESSAGE_CHARS, type InlineKeyboardMarkup } from "./api.ts";
import {
  escapeHtml,
  formatDate,
  formatItemCard,
  formatScoreBreakdown,
  localDateString,
  localDayMonthTime,
  sourceLabel,
} from "./format.ts";
import { esitoUltimoTentativo } from "./report.ts";
import { truncate } from "../lib/text.ts";
import { runOrigin } from "../schedule.ts";
import {
  BRANDS_PAGE_SIZE,
  PAGE_SIZE,
  archivioKeyboard,
  backKeyboard,
  cardKeyboard,
  couponViewsRows,
  helpKeyboard,
  helpRow,
  numeriKeyboard,
  rimborsiKeyboard,
  diagnosticaKeyboard,
  emptyKeyboard,
  filtriKeyboard,
  filtriFontiKeyboard,
  filtriMarcheKeyboard,
  fontiKeyboard,
  itemButtonLabel,
  listKeyboard,
  logKeyboard,
  marcheKeyboard,
  menuKeyboard,
  premiKeyboard,
  sectionTitle,
  settingsKeyboard,
  storicoKeyboard,
  vantaggioKeyboard,
} from "./keyboard.ts";
import { hourLabel, parseQuietRange } from "./prefs-config.ts";

/**
 * Le schermate del bot, come funzioni pure: dato lo stato della chat e i dati
 * letti dal database, producono il testo e la tastiera. Nessuna scrittura, nessuna
 * rete: qui si decide solo *cosa* si vede, e src/telegram/bot.ts lo applica al
 * messaggio unico della chat.
 *
 * Perché un solo messaggio: la chat deve restare leggibile. Il bot modifica
 * sempre lo stesso messaggio (menù → sezione → scheda) e cancella il comando
 * appena scritto, invece di accumulare messaggi uno sotto l'altro.
 */

export interface Screen {
  text: string;
  keyboard: InlineKeyboardMarkup;
}

/**
 * Cosa cambia un tocco nelle impostazioni: le preferenze delle consegne (soglia,
 * silenzio, ore del digest, notifiche) più i filtri ("cosa vedi") di QUESTA chat.
 * "hour" accende o spegne una singola ora del digest.
 */
export type ConfigKey =
  | "score"
  | "quiet"
  | "digest"
  | "hour"
  | "notify"
  | "cat"
  | "tag"
  | "src"
  | "free"
  | "star"
  /** Una marca del registro da accendere o spegnere nei preferiti. */
  | "brand"
  /** Il filtro "solo le marche che seguo" (on/off) e lo svuotamento dell'elenco (reset). */
  | "brands"
  | "reset";

const CONFIG_KEYS: readonly ConfigKey[] = [
  "score", "quiet", "digest", "hour", "notify", "cat", "tag", "src", "free", "star", "brand", "brands", "reset",
];

/** Cosa vuole fare l'utente: i bottoni e i comandi si traducono tutti qui. */
export type Intent =
  | { kind: "home" }
  | { kind: "refresh" }
  | { kind: "section"; section: string }
  | { kind: "page"; page: number }
  | { kind: "open"; itemId: number }
  | { kind: "back" }
  | { kind: "decision"; action: "save" | "unsave" | "ign" | "won"; itemId: number }
  /**
   * Un rimborso: richiedilo, segnalo ricevuto, annullalo. `ask` non scrive
   * niente — apre la domanda sull'importo, per i bandi che dichiarano una
   * percentuale invece di una cifra.
   */
  | { kind: "refund"; action: "claim" | "ask" | "receive" | "undo"; itemId: number }
  /** L'importo scritto in chat per un rimborso senza cifra fissa. */
  | { kind: "refundAmount"; itemId: number; cents: number | null }
  /**
   * 🔕 Mai più questa marca (muted = true) o 🔔 torna a mostrarla. Porta l'id
   * della marca, non quello dell'item: l'esclusione è per marca, e un concorso
   * vecchio della stessa insegna deve sparire insieme a quello che stai
   * guardando.
   */
  | { kind: "mutedBrand"; value: string; muted: boolean }
  | { kind: "config"; key: ConfigKey; value: string }
  | { kind: "none" };

/** Sezioni che si aprono dal menù (una pagina di elenco, non una scheda). */
export const SECTIONS = [
  "menu",
  "nuovi",
  "oggi",
  "settimana",
  "scadenze",
  "salvati",
  "news",
  "storico",
  "vinti",
  "scaduti",
  "ignorati",
  "cerca",
  "fonti",
  "vantaggio",
  "impostazioni",
  "filtri",
  "filtri-fonti",
  "filtri-marche",
  "preferiti",
  "preferiti-lista",
  "coupon",
  "numeri",
  "coupon-oggi",
  "coupon-settimana",
  "coupon-scadenze",
  "coupon-rimborsi",
  "gratis",
  "spesa",
  "premi",
  "rimborsi",
  "archivio",
  "diagnostica",
  "log",
  "aiuto",
] as const;

export function isKnownSection(section: string): boolean {
  if ((SECTIONS as readonly string[]).includes(section)) return true;
  if (section.startsWith("cerca:")) return true;
  // `archivio:<tipo>` si accetta solo per i tre tipi veri: una sezione inventata
  // non leggerebbe niente, mentre un tipo sbagliato letto come "tutto" darebbe
  // l'elenco completo credendo di averne chiesto una fetta (vedi archivioKindFor).
  if (section.startsWith("archivio:")) return archivioKindFor(section) !== null;
  // `aiuto:<id>`: la pagina della wiki si apre solo se esiste nell'elenco. Una
  // pagina inventata aprirebbe il vuoto, e un indice sbagliato la pagina sbagliata.
  if (section.startsWith("aiuto:")) return helpIndexFor(section.slice("aiuto:".length)) !== null;
  // `premi:<tag>` si accetta solo se il tag è uno di quelli offerti: una sezione
  // inventata non leggerebbe niente, e sarebbe un elenco vuoto senza spiegazione.
  return prizeFilterFor(section) !== null;
}

/** Traduce i `callback_data` dei bottoni in intenti. Ignora il resto. */
export function parseCallback(data: string | undefined): Intent {
  const raw = (data ?? "").trim();
  if (raw.length === 0) return { kind: "none" };
  const [head, ...rest] = raw.split(":");
  const first = rest[0] ?? "";

  switch (head) {
    case "home":
      return { kind: "home" };
    case "refresh":
      return { kind: "refresh" };
    case "back":
      return { kind: "back" };
    case "noop":
      return { kind: "none" };
    case "s": {
      // La sezione si ricompone INTERA: alcune hanno un prefisso (`premi:giftcard`,
      // `cerca:nutella`) e tagliarla al primo pezzo aprirebbe la porta sbagliata —
      // "premi:giftcard" diventerebbe "premi", cioè la schermata delle porte.
      const section = rest.join(":").toLowerCase();
      return isKnownSection(section) ? { kind: "section", section } : { kind: "none" };
    }
    case "page": {
      const page = Number.parseInt(first, 10);
      return Number.isFinite(page) && page >= 0 ? { kind: "page", page } : { kind: "none" };
    }
    case "open": {
      const itemId = Number.parseInt(first, 10);
      return Number.isFinite(itemId) ? { kind: "open", itemId } : { kind: "none" };
    }
    case "save":
    case "unsave":
    case "ign":
    case "won": {
      const itemId = Number.parseInt(first, 10);
      if (!Number.isFinite(itemId)) return { kind: "none" };
      // `unsave` è il ⭐ della scheda quando il concorso è già in watchlist: la
      // stessa riga di bottoni deve poterlo rimettere fuori, altrimenti una
      // decisione presa è per sempre.
      const action = head === "save" ? "save" : head === "unsave" ? "unsave" : head === "ign" ? "ign" : "won";
      return { kind: "decision", action, itemId };
    }
    case "rf": {
      // `rf:claim:12`, `rf:recv:12`, `rf:undo:12`, `rf:ask:12`.
      const action = first;
      const itemId = Number.parseInt(rest[1] ?? "", 10);
      if (!Number.isFinite(itemId)) return { kind: "none" };
      if (action === "claim" || action === "ask" || action === "recv" || action === "undo") {
        return {
          kind: "refund",
          action: action === "recv" ? "receive" : action === "ask" ? "ask" : action === "undo" ? "undo" : "claim",
          itemId,
        };
      }
      return { kind: "none" };
    }
    case "mb":
    case "um": {
      // `mb:<id>` = mai più questa marca, `um:<id>` = torna a mostrarla. L'id è
      // quello del registro (src/config/brands.ts), non un testo libero: sta in
      // un callback_data da 64 byte e non c'è niente da ripulire.
      if (!first || first.length > 40) return { kind: "none" };
      return { kind: "mutedBrand", value: first, muted: head === "mb" };
    }
    case "cfg": {
      const key = first as ConfigKey;
      const value = rest.slice(1).join(":");
      if (!CONFIG_KEYS.includes(key)) return { kind: "none" };
      return { kind: "config", key, value };
    }
    default:
      return { kind: "none" };
  }
}

/**
 * Dove si torna con ⬅️ Indietro quando la storia è vuota (chat ripresa dopo un
 * riavvio, o riga scritta da una versione che la storia non ce l'aveva). Non è
 * una seconda navigazione: è la rete di sicurezza perché nessuna schermata resti
 * senza uscita, che era il reclamo. La storia vera, quando c'è, ha la precedenza.
 */
const PARENT_SECTION: Record<string, string> = {
  "filtri-fonti": "filtri",
  "filtri-marche": "filtri",
  preferiti: "filtri",
  "preferiti-lista": "preferiti",
  impostazioni: "menu",
  fonti: "menu",
  diagnostica: "fonti",
  vantaggio: "fonti",
  log: "fonti",
  storico: "menu",
  numeri: "storico",
  vinti: "storico",
  scaduti: "storico",
  ignorati: "storico",
  archivio: "storico",
  "archivio:contest": "archivio",
  "archivio:coupon": "archivio",
  "archivio:news": "archivio",
  aiuto: "menu",
  cerca: "menu",
  rimborsi: "coupon",
  // Le viste dei coupon tornano alla sezione intera, non al menù: da ⏳ In
  // scadenza "indietro" vuol dire "fammi vedere tutti i coupon".
  "coupon-oggi": "coupon",
  "coupon-settimana": "coupon",
  "coupon-scadenze": "coupon",
  "coupon-rimborsi": "coupon",
};

export function parentSection(section: string): string {
  if (section.startsWith("aiuto:")) return "aiuto";
  if (section.startsWith("cerca:")) return "cerca";
  // La domanda sull'importo è una tappa del rimborso: indietro porta a 💰
  // Rimborsi, non al menù, anche quando la storia non c'è più.
  if (section.startsWith("importo:")) return "rimborsi";
  return PARENT_SECTION[section] ?? "menu";
}

/** Quanti passi indietro si ricordano: oltre, la storia diventa un labirinto. */
const HISTORY_MAX = 8;

/** Un passo in più nella storia, senza doppioni consecutivi e senza crescere. */
function pushHistory(history: NavPoint[] | undefined, point: NavPoint): NavPoint[] {
  const punti = history ?? [];
  const ultimo = punti[punti.length - 1];
  if (ultimo && ultimo.section === point.section && ultimo.page === point.page) return punti;
  return [...punti, point].slice(-HISTORY_MAX);
}

/**
 * Applica l'intento allo stato. È pura: le preferenze, le query e il momento in
 * cui il contatore dei "nuovi" riparte stanno in bot.ts (che deve leggere la
 * sezione *prima* di segnarla come vista, altrimenti l'elenco uscirebbe vuoto).
 */
export function applyIntent(state: UiState, intent: Intent, now: Date): UiState {
  void now;
  switch (intent.kind) {
    case "home":
      // Il menù è la radice: la storia riparte da qui.
      return { ...state, section: "menu", page: 0, openItemId: null, history: [] };
    case "refresh":
      return state;
    case "section": {
      // `aiuto` senza suffisso è l'INDICE degli argomenti (`page: -1`), mentre
      // `aiuto:<id>` è una pagina sola: la sezione resta "aiuto" (una schermata,
      // una tastiera) e il numero di pagina è l'indice della voce della wiki.
      const destinazione = intent.section.startsWith("aiuto:")
        ? { section: "aiuto", page: helpIndexFor(intent.section.slice("aiuto:".length)) ?? -1 }
        : { section: intent.section, page: intent.section === "aiuto" ? -1 : 0 };
      return {
        ...state,
        ...destinazione,
        openItemId: null,
        // Ogni porta che si apre lascia il segno: è quello che rende ⬅️ Indietro
        // un ritorno vero e non un salto al menù.
        history: pushHistory(state.history, { section: state.section, page: state.page }),
      };
    }
    case "page":
      // Cambiare pagina non è navigare: la storia resta com'è, altrimenti un
      // giro di frecce riempirebbe la storia di pagine e ⬅️ tornerebbe a una
      // pagina intermedia invece che alla schermata precedente.
      return { ...state, page: intent.page, openItemId: null };
    case "open":
      return { ...state, openItemId: intent.itemId };
    case "back": {
      // Dentro una scheda, "indietro" la chiude e torna all'elenco da cui si è
      // arrivati — con la SUA pagina, che lo stato ha conservato.
      if (state.openItemId !== null) return { ...state, openItemId: null };
      const storia = state.history ?? [];
      const precedente = storia[storia.length - 1];
      if (precedente) {
        return {
          ...state,
          section: precedente.section,
          page: precedente.page,
          openItemId: null,
          history: storia.slice(0, -1),
        };
      }
      return { ...state, section: parentSection(state.section), page: 0, openItemId: null };
    }
    case "decision":
      return { ...state, openItemId: intent.itemId };
    case "refund":
      return intent.action === "ask"
        ? {
            ...state,
            section: `importo:${intent.itemId}`,
            page: 0,
            openItemId: null,
            history: pushHistory(state.history, { section: state.section, page: state.page }),
          }
        : state;
    case "refundAmount":
      // Senza una cifra letta bene si resta sulla domanda: registrare zero o
      // l'ultimo numero visto sarebbe peggio che richiedere di riscriverla.
      return intent.cents === null
        ? state
        : {
            ...state,
            section: "rimborsi",
            page: 0,
            openItemId: null,
            history: pushHistory(state.history, { section: state.section, page: state.page }),
          };
    case "mutedBrand":
      // 🔕 toglie di mezzo il concorso che stai guardando (e tutta la sua
      // insegna): si torna all'elenco, che ora non lo contiene più. 🔔 invece
      // non deve muovere niente — sei in 🎛 Cosa vedi per riaccendere.
      return intent.muted && state.openItemId !== null ? { ...state, openItemId: null } : state;
    default:
      return state;
  }
}

export interface ScreenCounts {
  nuovi: number;
  oggi: number;
  settimana: number;
  scadenze: number;
  salvati: number;
  /** Articoli e pagine-contenitore in archivio (tutta la sezione news). */
  news: number;
  /** Coupon e rimborsi in archivio, con i filtri di questa chat. */
  coupon: number;
  /** Rimborsi richiesti e non ancora ricevuti: il numero sul bottone 💰. */
  rimborsi: number;
  /** Denaro ancora in attesa, in centesimi (l'etichetta del bottone lo mostra). */
  rimborsiCents: number;
  /** true se fra le attese c'è un tetto: il totale è un massimo, non la cifra. */
  rimborsiCap: boolean;
  /** Coupon e rimborsi in archivio, senza filtri: serve a dire "vedi X di Y". */
  couponTotal: number;
  /** Concorsi in archivio, di qualunque stato: la metà "buona" dell'archivio. */
  contest: number;
  /** Quante marche segue questa chat: è il numero sul bottone 🏷 Marche seguite. */
  seguite: number;
  /**
   * Concorsi delle marche seguite ADESSO, con i filtri della chat. Si conta solo
   * aprendo la sezione (è la riga "Segui 2 marche … — 7 concorsi in archivio"):
   * nel menù quel numero sarebbe una query a ogni schermata, e sul bottone non
   * ci sta comunque, perché lì il numero sono le marche.
   */
  concorsiMarche: number;
  /**
   * Quanti concorsi aprirebbe ciascuna porta di 🎁 Tipi di premio, per sezione
   * ("premi:giftcard", "gratis", "spesa"…). Si contano solo aprendo quella
   * schermata: sei query per un menù che non li mostra sarebbero lavoro per
   * niente. Anche le due metà dell'archivio stanno qui, perché è lì che si
   * leggono.
   */
  premi: Record<string, number>;
  /** Storico: contati solo quando si apre 🗂 Storico, per non pesare sul menù. */
  vinti: number;
  scaduti: number;
  ignorati: number;
  /** Quanti filtri sono accesi in questa chat: 0 = vede tutto l'archivio. */
  filtri: number;
  /** Archivi interi, senza filtri: servono a dire "vedi X di Y". */
  contestTotal: number;
  newsTotal: number;
}

export interface ScreenData {
  counts: ScreenCounts;
  /** Pagina effettiva, già riportata dentro l'intervallo valido. */
  page: number;
  /** Item della pagina corrente (per gli elenchi). */
  items: ItemRow[];
  /** Totale della sezione, non solo della pagina. */
  total: number;
  /** Scheda aperta, se `state.openItemId` è valorizzato. */
  openItem: ItemRow | null;
  /** Decisione di QUESTA chat sull'item aperto: "saved" | "ignored" | "won" | null. */
  decision: string | null;
  /** Link al regolamento trovato nel testo dell'item, se c'è. */
  regolamentoUrl: string | null;
  /** La richiesta di rimborso di questa chat per l'item aperto (solo coupon). */
  refund: RefundRow | null;
  /** La pagina di 💰 Rimborsi, già ritagliata. */
  refunds: RefundRow[];
  /** I totali dei rimborsi: in attesa e recuperati, cifre e conteggi. */
  refundTotals: RefundTotals;
  sources: SourceRow[];
  runs: RunRow[];
  /**
   * Quando è partita l'ultima raccolta vera (GitHub o un PC), ISO 8601; null se
   * non ce n'è ancora una o se questa schermata non la mostra. È l'ora che dice
   * se il radar è vivo — l'ora dell'ultimo tocco dice un'altra cosa.
   */
  ultimaRaccolta: string | null;
  /**
   * Le ultime esecuzioni con un log, dalla più recente: si legge solo in
   * 🧾 Log delle raccolte, e solo per l'admin.
   */
  logs: RunRow[];
  /**
   * true se la schermata è per l'admin (quella chat): decide i bottoni che
   * l'altra persona non deve vedere, come 🧾 Log delle raccolte.
   */
  isAdmin: boolean;
  /** Verdetto su ogni fonte accesa: si legge solo nella schermata della diagnostica. */
  diagnosi: Diagnosi[];
  /** I numeri della testata della diagnostica (null altrove). */
  diagnosiRiepilogo: RiepilogoDiagnosi | null;
  /** Statistiche del vantaggio di tempistica: solo nella sezione /vantaggio. */
  lead: LeadStats | null;
  /** Anticipo del concorso aperto in scheda, in ore: null se non è misurabile. */
  leadDelConcorso: number | null;
  prefs: Prefs;
  archiveTotal: number;
  /** Pagina di fonti da mostrare in 📡 Scegli le fonti (già ritagliata). */
  filterSources: FilterSource[];
  /** Quante fonti si possono spegnere in tutto (per la paginazione). */
  filterSourcesTotal: number;
  /** Pagina di marche da mostrare in 🏷 Marche seguite (già ritagliata). */
  brandChoices: BrandChoice[];
  /** Quante marche ha il registro in tutto (per la paginazione). */
  brandChoicesTotal: number;
  /**
   * Origine pubblica del Worker: l'URL della pagina di condivisione
   * (`/share`, src/share.ts). Arriva dalla richiesta, non da una costante.
   */
  shareBase: string;
}

/**
 * La data di un istante (ISO 8601) come si legge in Italia: un rimborso chiesto
 * alle 23:30 UTC è già del giorno dopo a Roma, e `formatDate` leggerebbe la
 * data UTC. Le scadenze sono date senza ora e restano su `formatDate`.
 */
function giornoItaliano(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "—";
  const [anno, mese, giorno] = localDateString(at).split("-");
  return `${giorno}/${mese}/${anno}`;
}

function oreMinuti(iso: string | null): string {
  if (!iso) return "mai";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "mai";
  return localDayMonthTime(at);
}

function headerLines(state: UiState, data: ScreenData, now: Date): string[] {
  const righe: string[] = [];
  if (state.section === "nuovi" && data.counts.nuovi > 0) {
    righe.push(`🆕 <b>${data.counts.nuovi} novità</b> dall'ultimo controllo`);
  }
  // L'archivio contiene due cose diverse: i concorsi su cui si partecipa e gli
  // articoli che ne parlano. Dirle entrambe evita di far sembrare l'archivio
  // grande quanto i concorsi.
  righe.push(
    `🗂 <b>${data.counts.contest}</b> concorsi · <b>${data.counts.coupon}</b> coupon · <b>${data.counts.news}</b> news in archivio`,
  );
  // Prima qui c'era "controllati 17/10 01:25": era l'ora dell'ultimo tocco di chi
  // guarda (è lei che fa ripartire il contatore delle novità), ma si leggeva come
  // "il bot si è fermato alle 01:25". L'ora che dice se il radar è vivo è quella
  // della RACCOLTA, che finora si trovava solo in 📡 Fonti.
  righe.push(
    data.ultimaRaccolta === null
      ? "🔄 Nessuna raccolta ancora"
      : `🔄 Ultima raccolta: ${oreMinuti(data.ultimaRaccolta)}`,
  );
  // Con i filtri accesi il numero di sopra è quello che VEDI, non quello che
  // esiste: senza questa riga l'archivio sembrerebbe più piccolo di com'è.
  if (data.counts.filtri > 0) {
    righe.push(
      `🎛 Filtri tuoi: <b>${data.counts.contest}</b> di <b>${data.counts.contestTotal}</b> concorsi · <b>${data.counts.coupon}</b> di <b>${data.counts.couponTotal}</b> coupon · <b>${data.counts.news}</b> di <b>${data.counts.newsTotal}</b> news`,
    );
  }
  return righe;
}

function listScreen(state: UiState, data: ScreenData, now: Date): Screen {
  const title = sectionTitle(state.section);
  // 📚 Archivio: le sue fette sono sezioni con un prefisso (`archivio:coupon`), e
  // per il nome delle voci e per i messaggi da elenco vuoto contano come una
  // sezione sola.
  const sezioneArchivio = state.section === "archivio" || state.section.startsWith("archivio:");
  // 💶 Coupon: le sue viste (`coupon-oggi`, `coupon-scadenze`…) per il sostantivo
  // contano come la sezione intera — "12 coupon", non "12 concorsi" — mentre i
  // messaggi da elenco vuoto hanno una frase per vista (sotto).
  const sezioneCoupon = state.section === "coupon" || state.section.startsWith("coupon-");
  const chiave = sezioneArchivio ? "archivio" : sezioneCoupon ? "coupon" : state.section;
  // Le righe in più sotto l'elenco: le viste dei coupon e il bottone d'aiuto
  // della sezione. L'aiuto sta in fondo perché si cerca, non si usa ogni volta.
  const righeExtra = [
    ...(sezioneCoupon ? couponViewsRows(state.section) : []),
    ...helpRow(helpPageForSection(state.section)),
  ];
  const pagine = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  // Un `page` fuori intervallo (messaggio vecchio, o lista che si è accorciata)
  // non deve mostrare una pagina vuota: si riporta dentro e si ri-renderizza.
  const page = Math.min(Math.max(data.page, 0), pagine - 1);

  // Sostantivo giusto per la sezione: nella news non si "tocca un concorso", e
  // nello storico non si sta guardando qualcosa da fare adesso.
  const nomi: Record<string, [string, string]> = {
    // L'archivio mescola i tre tipi: "concorsi" sarebbe una bugia sui coupon.
    archivio: ["item", "item"],
    news: ["articolo", "articoli"],
    salvati: ["concorso in watchlist", "concorsi in watchlist"],
    vinti: ["concorso vinto", "concorsi vinti"],
    scaduti: ["concorso chiuso", "concorsi chiusi"],
    ignorati: ["concorso scartato", "concorsi scartati"],
    // "un coupon" e "12 coupon": la parola non cambia al plurale.
    coupon: ["coupon", "coupon"],
  };
  const [singolare, plurale] = nomi[chiave] ?? ["concorso", "concorsi"];
  if (data.items.length === 0) {
    const vuoti: Record<string, string> = {
      salvati: "La watchlist è vuota: apri un concorso e tocca ⭐ Watchlist per non perderlo di vista.",
      news: "Nessun articolo qui: le news arrivano dalle fonti di cronaca, appena le trovano.",
      vinti: "Nessuna vittoria registrata: quando ne vinci uno, apri la scheda e tocca 🏆 Vinto.",
      scaduti: "Nessun concorso chiuso in archivio: qui finiscono quelli la cui scadenza è passata.",
      ignorati: "Non hai scartato niente: quello che tocchi 🚫 finisce qui, e da qui puoi riprenderlo.",
      "preferiti-lista":
        "Non segui ancora nessuna marca, quindi non c'è niente da mostrare qui: aprine una in 🏷 Marche seguite.",
      // 📋 Oggi si svuota ogni mezzanotte: a notte fonda è normale che sia
      // vuota, e senza dirlo sembrerebbe una sezione rotta (o peggio, si
      // aspetterebbe 🔄 Aggiorna che non può far comparire il giorno prima).
      oggi:
        "Oggi non è ancora arrivato niente: questa sezione conta il giorno di calendario e riparte da zero a mezzanotte. I concorsi di ieri sono in 📅 7 giorni, quelli chiusi in 📚 Archivio.",
      coupon:
        "Nessun coupon valido adesso: qui restano solo quelli ancora spendibili — i buoni scaduti sono in 📚 Archivio — e i nuovi arrivano appena le fonti li trovano.",
      // Un elenco vuoto in una vista dice cose diverse da un elenco vuoto in
      // tutte: "oggi non ne sono arrivati" non è "non ce ne sono".
      "coupon-oggi":
        "Oggi non è ancora arrivato nessun coupon: questa vista conta il giorno di calendario e riparte da zero a mezzanotte. Gli ultimi 7 giorni sono in 📅 7 giorni.",
      "coupon-settimana":
        "Nessun coupon negli ultimi 7 giorni: qui conta quando è ARRIVATO, non quando scade — per la validità c'è ⏳ In scadenza.",
      "coupon-scadenze":
        "Nessun coupon in scadenza nei prossimi 7 giorni: i buoni senza una data dichiarata non entrano qui (non sappiamo quando scadono) e restano in 🗂 Tutti.",
      "coupon-rimborsi":
        "Nessun rimborso o cashback adesso: questa fetta tiene le offerte in cui si compra e tornano soldi (spendi e riprendi, cashback, rimborsi). I buoni sconto sono in 🗂 Tutti.",
      gratis:
        "Nessun concorso senza acquisto qui: per ora tutti quelli in archivio chiedono uno scontrino, un codice o una spesa minima. La metà opposta è in 💸 Con acquisto.",
      spesa:
        "Nessun concorso con acquisto qui: per ora in archivio ci sono solo iniziative senza spesa. La metà opposta è in 🆓 Gratis.",
      archivio:
        "L'archivio è vuoto: qui finisce tutto quello che il bot ha visto e vedrà, quindi si riempie alla prima raccolta.",
      ...Object.fromEntries(
        PRIZE_QUICK_FILTERS.filter((voce) => voce.tag !== null).map((voce) => [
          voce.section,
          `Nessun concorso con ${voce.label.toLowerCase()} in palio adesso: il tipo lo decide quello che la pagina dichiara, e in questo momento nessun concorso dell'archivio lo dichiara.`,
        ]),
      ),
      // Le due classi nuove hanno una frase loro: quella generica direbbe "un
      // omaggio con acquisto in palio", che è il contrario di quello che sono.
      "premi:premio_certo":
        "Nessun premio certo adesso: sono i concorsi in cui il premio è garantito a chi partecipa, non un'estrazione. Ne arrivano quasi tutti da Scontrino Felice · premio certo, e la porta si riempie al prossimo giro di quella fonte.",
      "premi:omaggio_con_acquisto":
        "Nessun omaggio con acquisto adesso: qui stanno i regali che si ricevono comprando (richiedi il set, ritiri il gadget), non le estrazioni. Il tipo lo decide quello che la pagina dichiara.",
    };
    // Nell'archivio i filtri non contano (si vede tutto per definizione):
    // attribuire a loro un elenco vuoto sarebbe la spiegazione sbagliata.
    const filtrata = data.counts.filtri > 0 && !sezioneArchivio;
    const righeVuote = [
      `📭 <b>${escapeHtml(title)}</b>`,
      "",
      vuoti[state.section] ?? vuoti[chiave] ?? "Nessun concorso qui. Tocca 🔄 Aggiorna più tardi.",
    ];
    // Un elenco vuoto può voler dire due cose opposte: non c'è niente, oppure i
    // filtri hanno lasciato fuori tutto. Dirlo è la differenza fra "aspetto" e
    // "ho sbagliato un tasto".
    if (filtrata) {
      righeVuote.push("", `🎛 Hai <b>${data.counts.filtri}</b> filtri attivi: può essere per quello.`);
    }
    return {
      text: righeVuote.join("\n"),
      keyboard: emptyKeyboard(filtrata, state.section === "preferiti-lista", righeExtra),
    };
  }

  const nome = data.total === 1 ? singolare : plurale;
  const righe = [
    `<b>${escapeHtml(title)}</b> · ${data.total} ${nome}${
      pagine > 1 ? ` · pagina ${page + 1}/${pagine}` : ""
    }`,
    "",
    state.section === "news"
      ? "Sono articoli, non concorsi: il link porta al pezzo."
      : state.section === "coupon"
        ? "Buoni sconto e rimborsi: si spende meno, non si vince."
      : state.section === "coupon-oggi"
        ? "I coupon arrivati da mezzanotte: qui conta la novità, non la scadenza."
      : state.section === "coupon-settimana"
        ? "I coupon arrivati negli ultimi 7 giorni, dal più recente."
      : state.section === "coupon-scadenze"
        ? "I coupon con una validità che finisce entro 7 giorni: chi chiude prima sta in cima."
      : state.section === "coupon-rimborsi"
        ? "Spendi e riprendi, cashback e rimborsi: qui si compra e tornano soldi, non si ritaglia un buono. In cima chi rende di più per ogni euro speso; chi non dichiara la spesa resta in fondo. La stessa offerta raccontata da più fonti è una riga sola."
        : state.section === "gratis"
        ? "Solo concorsi senza acquisto: niente scontrino, niente codice, niente spesa minima."
        : state.section === "spesa"
        ? "Solo concorsi con acquisto: serve uno scontrino, un codice o una spesa minima. L'altra metà è in 🆓 Gratis."
        : state.section === "premi:premio_certo"
        ? "Solo concorsi con un premio garantito: non è un'estrazione. È una porta, non un filtro: i tuoi filtri restano come sono."
        : state.section === "premi:omaggio_con_acquisto"
        ? "Solo regali che si ricevono comprando: il premio è tuo, non si vince. È una porta, non un filtro."
        : state.section.startsWith("premi:")
        ? "Solo concorsi con questo premio. È una porta, non un filtro: i tuoi filtri restano come sono."
        : state.section === "salvati"
        ? "Chi chiude prima sta in cima. Ti avviso 3 giorni e 1 giorno prima; per le raccolte punti molto prima."
        : state.section === "preferiti-lista"
          ? "Solo le marche che segui, dal punteggio più alto."
        : sezioneArchivio
          ? "Tutto quello che il bot ha visto, anche chiuso (⛔). I filtri di 🎛 Cosa vedi qui non valgono."
          : "Tocca un concorso per aprirlo:",
  ];
  return {
    text: righe.join("\n"),
    keyboard: sezioneArchivio
      ? archivioKeyboard(data.items, now, { index: page, total: pagine }, {
          sezione: state.section,
          totale: data.archiveTotal,
          concorsi: data.counts.contestTotal,
          coupon: data.counts.couponTotal,
          articoli: data.counts.newsTotal,
        })
      : listKeyboard(data.items, now, { index: page, total: pagine }, stellePer(data, state.section), righeExtra),
  };
}

/**
 * Le sezioni dove la soglia delle stelle si mostra: sono quelle che leggono
 * l'archivio per suggerire qualcosa. News ha un punteggio che vuol dire altro,
 * e Watchlist, Storico e Cerca sono scelte esplicite: lì una riga in più sarebbe
 * solo un tasto che non serve.
 */
const SEZIONI_STELLE = new Set([
  "nuovi", "oggi", "settimana", "scadenze", "scaduti", "preferiti-lista", "gratis", "spesa",
]);

function stellePer(data: ScreenData, section: string): number | null {
  // Anche le porte per tipo di premio sono sezioni che suggeriscono ("quale
  // viaggio vale la pena?"): la riga delle stelle si mostra, come in 📋 Oggi.
  return SEZIONI_STELLE.has(section) || section.startsWith("premi:") ? data.prefs.filters.minScore : null;
}

/**
 * Durata in parole. In chat il decimale non serve: "6,3 ore" non dice niente a
 * nessuno, "6 ore" sì.
 */
function durata(ore: number): string {
  const quanta = Math.abs(ore);
  if (quanta < 1) return "meno di un'ora";
  if (quanta < 24) {
    const intere = Math.round(quanta);
    return intere === 1 ? "un'ora" : `${intere} ore`;
  }
  const giorni = Math.round(quanta / 24);
  return giorni === 1 ? "un giorno" : `${giorni} giorni`;
}

/** "6 ore prima", "2 giorni dopo", "insieme": il verso conta quanto la misura. */
function anticipo(ore: number): string {
  if (Math.abs(ore) < 0.5) return "insieme";
  return ore > 0 ? `${durata(ore)} prima` : `${durata(ore)} dopo`;
}

/**
 * Il vantaggio di tempistica: di quanto vediamo un concorso prima degli
 * aggregatori. È una misura con tre limiti dichiarati dentro la schermata — da
 * quando esiste, su quanti concorsi si può calcolare, e quante fonti sono in
 * errore — perché un anticipo misurato mentre la raccolta è ferma non è un
 * anticipo.
 */
function vantaggioScreen(data: ScreenData): Screen {
  const righe = ["🏁 <b>Vantaggio di tempistica</b>", ""];
  const lead = data.lead;
  if (!lead || lead.concorsi === 0) {
    righe.push(
      "Da adesso registro <b>quando</b> ogni fonte vede un concorso, così posso dire di quanto arriviamo prima degli aggregatori.",
      "",
      "Ancora nessun concorso visto da entrambi i canali: il primo numero arriva appena un aggregatore riprende qualcosa che ho già in archivio.",
    );
    return { text: righe.join("\n"), keyboard: vantaggioKeyboard() };
  }

  righe.push(
    `Ultimi 30 giorni · <b>${lead.concorsi}</b> ${lead.concorsi === 1 ? "concorso visto" : "concorsi visti"} almeno una volta`,
    `Misuro da <b>${lead.daGiorni}</b> ${lead.daGiorni === 1 ? "giorno" : "giorni"} (la tabella parte vuota)`,
  );

  if (lead.confrontabili === 0) {
    righe.push(
      "",
      "Nessun concorso visto sia da una fonte diretta sia da un aggregatore: finché le due strade non si incrociano il confronto non esiste.",
    );
  } else {
    righe.push(
      "",
      `📊 Su <b>${lead.confrontabili}</b> ${lead.confrontabili === 1 ? "concorso visto" : "concorsi visti"} da entrambi i canali:`,
      `⏱ Mediana <b>${anticipo(lead.medianaOre ?? 0)}</b>${
        lead.p25Ore !== null && lead.p75Ore !== null && lead.p25Ore !== lead.p75Ore
          ? ` · metà dei casi fra ${anticipo(lead.p25Ore)} e ${anticipo(lead.p75Ore)}`
          : ""
      }`,
      `🥇 Prima noi: <b>${lead.avanti}</b> · 🐌 prima loro: <b>${lead.dietro}</b>${
        lead.insieme > 0 ? ` · 🤝 stesso giro: <b>${lead.insieme}</b>` : ""
      }`,
    );
  }

  righe.push(
    "",
    `🎯 Solo da fonti dirette: <b>${lead.soloDiretti}</b> — gli aggregatori non li hanno ripresi`,
    `🕳 Solo dagli aggregatori: <b>${lead.soloAggregatori}</b> — questi ci sono sfuggiti`,
  );

  if (lead.avanti > 0) {
    righe.push(
      "",
      "Quando eravamo avanti:",
      `• entro 6 ore: ${lead.fasce.entro6h}`,
      `• 6–24 ore: ${lead.fasce.entroGiorno}`,
      `• 1–3 giorni: ${lead.fasce.entro3giorni}`,
      `• oltre 3 giorni: ${lead.fasce.oltre}`,
    );
  }

  const attive = data.sources.filter((source) => source.enabled);
  const inErrore = attive.filter((source) => source.failStreak > 0).length;
  if (attive.length > 0) {
    righe.push(
      "",
      `📡 <b>${inErrore}</b> fonti su <b>${attive.length}</b> hanno fallito l'ultimo giro: nei giorni in cui la raccolta è ferma il numero qui sopra misura il fermo, non la velocità.`,
    );
  }

  return { text: righe.join("\n"), keyboard: vantaggioKeyboard() };
}

function cardScreen(state: UiState, data: ScreenData, now: Date): Screen {
  const item = data.openItem;
  if (!item) {
    return { text: "🤔 Questo concorso non è più in archivio.", keyboard: backKeyboard() };
  }
  const stato =
    data.decision === "saved"
      ? "⭐ <b>Nella tua watchlist</b>"
      : data.decision === "ignored"
        ? "🚫 <b>Ignorato da te</b>"
        : data.decision === "won"
          ? "🏆 <b>Segnato come vinto</b>"
          : data.decision === "sent"
            ? "📨 <b>Già inviato a te</b>"
            : null;
  // Il denaro è la ragione per cui un coupon si salva: lo stato del rimborso va
  // in testa alla scheda, con la data, perché "in attesa" senza "da quando" non
  // dice se è un ritardo o una richiesta di stamattina.
  const rimborso =
    data.refund === null
      ? null
      : data.refund.receivedAt === null
        ? `💰 <b>Rimborso richiesto</b> · ${refundAmountLabel(data.refund)} in attesa dal ${giornoItaliano(data.refund.claimedAt)}`
        : `✅ <b>Rimborso ricevuto</b> · ${refundAmountLabel(data.refund)} il ${giornoItaliano(data.refund.receivedAt)}`;

  const righe: string[] = [];
  // Decisione e rimborso sono lo stesso blocco: due paragrafi separati, ognuno
  // col suo spazio, facevano sembrare la scheda cominciata due volte. Prima il
  // denaro, perché è la cosa che si sta aspettando.
  const statoRighe = [rimborso, stato].filter((linea): linea is string => linea !== null);
  if (statoRighe.length > 0) righe.push(statoRighe.join("\n"), "");
  righe.push(formatItemCard(item, now));
  // Le voci del punteggio: solo per i concorsi. Un coupon non si giudica con
  // "quanto vale la pena guardare questo concorso" (lì il numero non c'è
  // proprio) e su un articolo la soglia delle stelle non si applica: una
  // spiegazione che parla di un filtro che non c'è sarebbe peggio di nessuna.
  if (item.kind === "contest") {
    const spiegazione = explainScore(insightFromRow(item), item, data.prefs.weights, now, data.prefs.filters.favoriteBrands);
    righe.push(
      "",
      formatScoreBreakdown(spiegazione, { soglia: data.prefs.filters.minScore, salvato: item.score }),
    );
  }
  // Il piede: il vantaggio misurato su QUESTO concorso (la riga che rende il
  // numero di /vantaggio verificabile caso per caso) e l'id. La fonte non si
  // ripete: è già la riga che chiude la scheda, due centimetri sopra.
  const fondo: string[] = [];
  if (data.leadDelConcorso !== null) {
    fondo.push(
      data.leadDelConcorso > 0.5
        ? `🏁 Visto <b>${durata(data.leadDelConcorso)}</b> prima degli aggregatori`
        : data.leadDelConcorso < -0.5
          ? `🏁 Gli aggregatori l'hanno visto <b>${durata(data.leadDelConcorso)}</b> prima`
          : "🏁 Visto dagli aggregatori nello stesso giro",
    );
  }
  fondo.push(`🆔 <code>${item.id}</code>`);
  righe.push("", fondo.join("\n"));
  return {
    text: righe.join("\n"),
    keyboard: cardKeyboard(
      item,
      data.decision,
      data.regolamentoUrl,
      data.shareBase,
      data.refund,
      now,
      typeof item.brand === "string" && data.prefs.filters.mutedBrands.includes(item.brand),
    ),
  };
}

function sourcesScreen(data: ScreenData): Screen {
  const attive = data.sources.filter((source) => source.enabled).length;
  const righe = [`📡 <b>Fonti</b> · ${data.sources.length} configurate, ${attive} attive`, ""];
  for (const source of data.sources) {
    if (!source.enabled) {
      righe.push(`⚪️ ${escapeHtml(source.name)} · spenta`);
      continue;
    }
    // Si racconta l'ULTIMO tentativo, non l'ultimo successo: "quando è andata
    // bene l'ultima volta" non dice se la fonte risponde ADESSO, che è la
    // domanda quando una fonte smette di portare roba. Il codice HTTP e i item
    // letti sono quelli che prima esistevano solo nel log del runner.
    const esito = esitoUltimoTentativo(source);
    const quando = source.lastRunAt === null ? "mai provata" : oreMinuti(source.lastRunAt);
    const sospetta = source.failStreak > 0 ? ` · ⚠️ ${source.failStreak} di fila` : "";
    righe.push(
      `${esito.emoji} ${escapeHtml(source.name)} · ${quando} · ${escapeHtml(truncate(esito.motivo, 60))}${sospetta}`,
    );
  }

  if (data.runs.length > 0) {
    righe.push("", "🕒 <b>Ultime raccolte</b>");
    for (const run of data.runs.slice(0, 4)) {
      const origine = runOrigin(run.trigger);
      righe.push(
        `• ${origine} ${oreMinuti(run.startedAt)} · ${run.sourcesOk} ok / ${run.sourcesFail} errori · ${run.itemsNew} nuovi`,
      );
    }
  }
  return { text: righe.join("\n"), keyboard: fontiKeyboard(data.isAdmin) };
}

/**
 * 🧾 Log delle raccolte (solo admin): il racconto di un lancio, per intero.
 *
 * Perché non è più un messaggio che arriva da sé: un riepilogo mandato a ogni
 * raccolta — ogni mezz'ora — diventa rumore, e il rumore si smette di leggere,
 * mentre la domanda "chi non risponde?" torna ogni volta che si cambia una fonte
 * o che l'archivio si ferma. Qui il racconto resta al suo posto, uno per lancio,
 * e si apre quando serve.
 *
 * La riga di testa dice da dove viene il giro (`GitHub`, `questo PC`, `Worker`) e
 * come è finito, perché il log di una raccolta di riserva non è quello di una
 * raccolta piena: scambiarli farebbe cercare un guasto che non c'è.
 */
function logScreen(data: ScreenData): Screen {
  const logs = data.logs;
  const pagina = Math.min(Math.max(data.page, 0), Math.max(0, logs.length - 1));
  const esecuzione = logs[pagina] ?? null;

  if (esecuzione === null || esecuzione.log === null) {
    return {
      text: [
        "🧾 <b>Log delle raccolte</b>",
        "",
        "Ancora nessun log: il primo lo scrive la prossima raccolta (quella su GitHub, una lanciata da qui, o la raccolta di riserva del Worker).",
        "",
        "In chat non arriva più nessun riepilogo: il racconto di ogni lancio si legge qui.",
      ].join("\n"),
      keyboard: logKeyboard({ index: 0, total: 1 }),
    };
  }

  const righe = [
    `🧾 <b>Log delle raccolte</b> · ${pagina + 1}/${logs.length}`,
    "",
    `${runOrigin(esecuzione.trigger)} · ${oreMinuti(esecuzione.startedAt)} · ${esecuzione.sourcesOk} ok / ${esecuzione.sourcesFail} errori · ${esecuzione.itemsNew} nuovi`,
    "",
  ];
  // Il log di un giro con trenta fonti può superare quello che Telegram accetta
  // in un messaggio: si taglia la coda (le fonti che hanno risposto stanno in
  // fondo, i guasti in cima) e il … dice che manca qualcosa. Meglio un log
  // troncato, che si apre, di uno che fa fallire la modifica del messaggio.
  const spazio = MAX_MESSAGE_CHARS - righe.join("\n").length - 120;
  righe.push(esecuzione.log.length > spazio ? truncate(esecuzione.log, spazio) : esecuzione.log);
  righe.push(
    "",
    "Un log per ogni raccolta, il più recente per primo. Questa schermata la vedi solo tu.",
  );
  return { text: righe.join("\n"), keyboard: logKeyboard({ index: pagina, total: logs.length }) };
}

/**
 * 🌡 Diagnostica delle fonti: quali valgono e quali no.
 *
 * Rispetto a 📡 Fonti, che risponde a "chi ha risposto?", qui la domanda è "e
 * questa fonte serve a qualcosa?". L'elenco è raggruppato per problema — prima
 * chi fallisce, poi chi risponde senza portare concorsi — e ogni riga dice il
 * fatto e che farne; in fondo, in una riga sola, le fonti che lavorano.
 *
 * Quello che NON c'è: un ordine di cancellazione. Il verdetto è un indizio, non
 * una decisione, e le due righe finali lo dicono (la fonte si toglie dal file di
 * configurazione; per non vederla solo per un po' basta 🎛 Scegli le fonti).
 *
 * Il tetto alle voci raccontate per esteso è quel che ci sta in un messaggio
 * (MAX_MESSAGE_CHARS): oltre, la schermata elenca gli id di quelle che restano,
 * perché l'id è la parte su cui si agisce e un elenco che ne nascondesse una
 * toglierebbe proprio una delle fonti da togliere.
 */
const DIAGNOSI_MAX = 12;

function diagnosticaScreen(data: ScreenData): Screen {
  const diagnosi = data.diagnosi;
  const riepilogo = data.diagnosiRiepilogo ?? { accese: 0, utili: 0, rotte: 0, daGuardare: 0 };
  const righe = [
    "🌡 <b>Diagnostica delle fonti</b>",
    "",
    riepilogo.daGuardare === 0
      ? `👌 Nessuna delle <b>${riepilogo.accese}</b> fonti accese ha qualcosa che non va.`
      : `🩺 <b>${riepilogo.daGuardare}</b> fonti da guardare su <b>${riepilogo.accese}</b> accese · <b>${riepilogo.utili}</b> portano concorsi nuovi e non falliscono.`,
  ];

  // Solo le fonti con qualcosa da dire, e solo per il numero di righe che ci sta
  // in un messaggio: un elenco di venti voci non si legge, e le fonti sane sono
  // già contate nella riga in testa.
  let righeLibere = DIAGNOSI_MAX;
  for (const gruppo of GRUPPI_DIAGNOSI) {
    const voci = diagnosi.filter((voce) => gruppo.esiti.includes(voce.esito));
    if (voci.length === 0) continue;
    const visibili = voci.slice(0, Math.max(0, righeLibere));
    const resto = voci.slice(visibili.length);
    righeLibere -= visibili.length;
    righe.push("", `<b>${gruppo.titolo}</b> (${voci.length})`);
    for (const voce of visibili) {
      righe.push(
        `${voce.emoji} <code>${escapeHtml(voce.source.id)}</code> · ${escapeHtml(voce.source.name)}`,
        `   ${escapeHtml(truncate(voce.motivo, 120))}`,
      );
      if (voce.consiglio.length > 0) righe.push(`   ↳ <i>${escapeHtml(truncate(voce.consiglio, 140))}</i>`);
    }
    if (resto.length > 0) {
      // Il motivo è lo stesso di quelli sopra (è lo stesso gruppo): qui serve solo
      // sapere CHI sono, e l'id è quello che si va a cercare in sources.ts.
      righe.push(
        `   … e altre ${resto.length}: ${resto.map((voce) => `<code>${escapeHtml(voce.source.id)}</code>`).join(" · ")}`,
      );
    }
  }

  righe.push("", `✅ Le altre <b>${riepilogo.utili}</b> fonti portano concorsi nuovi e non falliscono.`);
  righe.push(
    "",
    "🔧 Per toglierne una:<code> enabled: false</code> nella sua voce di src/config/sources.ts, poi <code>npm run db:seed</code>. Per non vederla solo qui: 🎛 Scegli le fonti.",
  );
  return { text: righe.join("\n"), keyboard: diagnosticaKeyboard() };
}

function settingsScreen(data: ScreenData): Screen {
  const { prefs } = data;
  const fascia = parseQuietRange(prefs.quietHours);
  const silenzio = fascia === null ? "nessuno" : `${hourLabel(fascia.start)}–${hourLabel(fascia.end)}`;
  const digest =
    prefs.digestHours.length === 0
      ? "spenti"
      : prefs.digestHours.map((hour) => hourLabel(hour)).join(", ");
  const righe = [
    "⚙️ <b>Impostazioni</b>",
    "",
    `🔔 Avvisi immediati: solo sopra <b>${prefs.minScoreInstant}</b>/100`,
    `🌙 Silenzio: <b>${silenzio}</b>`,
    `📬 Digest: <b>${digest}</b>`,
    `📣 Notifiche: <b>${prefs.active ? "attive" : "sospese"}</b>`,
    `🎛 Cosa vedi: <b>${isSeeingAll(prefs.filters) ? "tutto" : `${data.counts.filtri} filtri attivi`}</b>`,
    "",
    "➖ ➕ spostano di poco; le voci in fondo sono i valori soliti.",
    "Le ore del digest valgono anche nell'ora prima e dopo: è la tolleranza per l'ora legale.",
    "Valgono solo per te: l'altra persona ha le sue.",
  ];
  return { text: righe.join("\n"), keyboard: settingsKeyboard(prefs) };
}

function filtriScreen(data: ScreenData): Screen {
  const { prefs } = data;
  const filtro = prefs.filters;
  const righe = [
    "🎛 <b>Cosa vedi</b>",
    "",
    "✅ mostra · 🚫 nasconde. Vale <b>solo per te</b>: l'altra persona ha i suoi filtri, e anche gli avvisi seguono questi.",
    "",
    ...(filtro.minScore > 0
      ? [`⭐ Stelle minime: <b>${filtro.minScore}</b>/100 — vedi solo la testa della classifica.`]
      : ["⭐ Stelle minime: <b>nessuna</b> — gli elenchi sono comunque ordinati dal punteggio più alto."]),
    `🏷 Marche seguite: <b>${
      filtro.favoriteBrands.length === 0 ? "nessuna" : escapeHtml(filtro.favoriteBrands.map((id) => brandLabel(id)).join(", "))
    }</b>${onlyFavoriteBrands(filtro) ? " — e vedi solo queste" : ""}`,
    filtro.mutedBrands.length === 0
      ? "🔕 Marche spente: <b>nessuna</b> — si spengono dalla scheda di un concorso, con 🔕 Mai più."
      : `🔕 Marche spente: <b>${filtro.mutedBrands.length}</b> — ${escapeHtml(
          filtro.mutedBrands.map((id) => brandLabel(id)).join(", "),
        )}`,
    "",
  ];
  if (isSeeingAll(filtro)) {
    righe.push(`👁 Stai vedendo <b>tutto</b>: ${data.archiveTotal} item in archivio.`);
  } else {
    const pezzi: string[] = [];
    if (filtro.mutedCategories.length > 0) {
      pezzi.push(filtro.mutedCategories.map((categoria) => CATEGORY_LABELS[categoria]).join(", "));
    }
    if (filtro.mutedSources.length > 0) pezzi.push(`${filtro.mutedSources.length} fonti spente`);
    if (filtro.mutedTags.length > 0) pezzi.push(`${filtro.mutedTags.length} tipi spenti`);
    if (filtro.mutedBrands.length > 0) pezzi.push(`${filtro.mutedBrands.length} marche spente`);
    if (filtro.freeOnly) pezzi.push("solo senza acquisto");
    if (onlyFavoriteBrands(filtro)) pezzi.push("solo le marche seguite");
    righe.push(`👁 <b>${data.counts.contest}</b> di <b>${data.counts.contestTotal}</b> concorsi visibili.`);
    righe.push(`🚫 Fuori: ${escapeHtml(pezzi.join(" · "))}`);
  }
  righe.push("", "Restano sempre complete ⭐ Watchlist, 🗂 Storico e 🔍 Cerca: lì hai scelto tu cosa guardare.");
  return {
    text: righe.join("\n"),
    keyboard: filtriKeyboard(prefs, {
      sources: data.filterSourcesTotal,
      spenti: mutedSourceIds(filtro).length,
    }),
  };
}

/**
 * 🔕 Marche spente: le insegne che questa chat non vuole più vedere. Una riga
 * per marca, e toccandola si riaccende. È una schermata necessaria, non un
 * doppione di 🎛 Cosa vedi: una marca spenta non compare in nessun elenco,
 * quindi senza questa porta resterebbe spenta per sempre.
 */
function filtriMarcheScreen(data: ScreenData): Screen {
  const spente = data.prefs.filters.mutedBrands;
  const righe = [
    "🔕 <b>Marche spente</b>",
    "",
    "I concorsi di queste insegne non compaiono negli elenchi né negli avvisi. Tocca una marca per riaccenderla.",
    "",
    spente.length === 0
      ? "Non hai spento nessuna marca. Si spegne dalla scheda di un concorso, con 🔕 Mai più."
      : `Spente: <b>${spente.length}</b> — ${escapeHtml(spente.map((id) => brandLabel(id)).join(", "))}.`,
  ];
  return { text: righe.join("\n"), keyboard: filtriMarcheKeyboard(spente) };
}

/**
 * 🏷 Marche seguite: l'elenco delle marche da seguire, con quanti concorsi ha
 * ciascuna in archivio. È una schermata di scelte, quindi dice cosa cambia
 * accendere una marca — un punteggio più alto, una sezione sua e un avviso
 * quando ne esce un concorso — invece di lasciarlo scoprire toccando.
 *
 * Si chiamava "Preferiti per marca", e il nome faceva pensare a concorsi messi
 * da parte per marca (la watchlist, insomma): qui invece si sceglie quali marche
 * seguire, e non si salva nessun concorso.
 */
function marcheScreen(data: ScreenData): Screen {
  const { prefs } = data;
  const seguite = prefs.filters.favoriteBrands;
  const pagine = Math.max(1, Math.ceil(data.brandChoicesTotal / BRANDS_PAGE_SIZE));
  const page = Math.min(Math.max(data.page, 0), pagine - 1);
  const righe = [
    "🏷 <b>Marche seguite</b>",
    "",
    "Tocca una marca per seguirla: ⬜️ no · ✅ sì. Tra parentesi, quanti concorsi ha in archivio adesso; in cima stanno quelle che ne hanno di più.",
    "Se la segui, i suoi concorsi <b>valgono 10 punti in più</b>, hanno una sezione loro (📋 I loro concorsi) e ti avviso appena ne esce uno.",
    "",
    seguite.length === 0
      ? "Non segui ancora nessuna marca."
      : `Segui <b>${seguite.length}</b> ${seguite.length === 1 ? "marca" : "marche"}: ${escapeHtml(
          seguite.map((id) => brandLabel(id)).join(", "),
        )} — <b>${data.counts.concorsiMarche}</b> concorsi in archivio.`,
  ];
  if (onlyFavoriteBrands(prefs.filters)) {
    righe.push("🌟 Filtro acceso: negli elenchi e negli avvisi vedi <b>solo</b> queste marche.");
  }
  righe.push("", `Pagina ${page + 1}/${pagine} delle marche · vale solo per te.`);
  return {
    text: righe.join("\n"),
    keyboard: marcheKeyboard(data.brandChoices, {
      seguite: seguite.length,
      brandsOnly: prefs.filters.brandsOnly,
      page: { index: page, total: pagine },
    }),
  };
}

function filtriFontiScreen(data: ScreenData): Screen {
  const pagine = Math.max(1, Math.ceil(data.filterSourcesTotal / PAGE_SIZE));
  const page = Math.min(Math.max(data.page, 0), pagine - 1);
  const righe = [
    `📡 <b>Scegli le fonti</b> · pagina ${page + 1}/${pagine}`,
    "",
    "Tocca una fonte per spegnerla: i suoi concorsi non arrivano più né negli elenchi né negli avvisi.",
  ];
  return {
    text: righe.join("\n"),
    keyboard: filtriFontiKeyboard(data.filterSources, mutedSourceIds(data.prefs.filters), { index: page, total: pagine }),
  };
}

/**
 * 🎁 Tipi di premio: otto porte — sei per tipo di premio (compresi 🎁 Premio
 * certo e 🛍️ Omaggi con acquisto), più 💸 Con acquisto, che con 🆓 Gratis divide
 * l'archivio in due metà. Le due metà stanno una accanto all'altra, perché la
 * domanda opposta nasce guardando la prima.
 *
 * Perché è una schermata e non filtri in 🎛 Cosa vedi: i filtri sono esclusioni
 * che RESTANO accese e cambiano tutte le sezioni — chi vuole solo dare
 * un'occhiata alle gift card non vuole smettere di vedere il resto. Qui si entra,
 * si guarda, si esce: nessuna preferenza toccata, e il numero sul bottone è
 * quanti concorsi aprirebbe adesso.
 */
function premiScreen(data: ScreenData): Screen {
  const righe = [
    "🎁 <b>Tipi di premio</b>",
    "",
    "Non sono filtri: non cambiano niente per le altre sezioni e non restano accesi. Toccane una e vedi solo i concorsi con quel premio, con i filtri che hai già.",
    "",
    "🎁 Premio certo sono i concorsi in cui il premio è garantito (non un'estrazione); 🛍️ Omaggi con acquisto sono i regali che si ricevono comprando.",
    "",
    "Le ultime due dividono l'archivio per quello che costa partecipare: 🆓 Gratis quelli dove non si compra niente, 💸 Con acquisto quelli dove serve una spesa.",
    "",
    "Il numero è quanti concorsi aprirebbe adesso — se è <b>0</b>, quel tipo non c'è in archivio in questo momento.",
  ];
  return { text: righe.join("\n"), keyboard: premiKeyboard(data.counts.premi) };
}

function searchPromptScreen(): Screen {
  return {
    text: [
      "🔍 <b>Cerca</b>",
      "",
      "Scrivi la parola da cercare (per esempio <i>gift card</i>, <i>auto</i>, <i>scontrino</i>).",
      "Il tuo messaggio viene cancellato e i risultati compaiono qui.",
    ].join("\n"),
    keyboard: backKeyboard(),
  };
}

/**
 * ❓ Aiuto: una pagina della wiki per volta, con le frecce.
 *
 * Il testo viene dal catalogo (src/telegram/help.ts), non da qui: aggiungere una
 * pagina non deve voler dire toccare la schermata, e chi scrive la wiki non deve
 * leggere il codice per farlo.
 */
function helpScreen(data: ScreenData): Screen {
  const indice = data.page;
  const pagina = indice >= 0 && indice < HELP_PAGES.length ? HELP_PAGES[indice] : null;
  // L'indice: un bottone per argomento, nessuna freccia. `page: -1` è il segno
  // "indice" (vedi applyIntent), quindi qui non si clampa a zero: clampare
  // riporterebbe alla prima pagina e l'indice non esisterebbe più.
  if (pagina === null) {
    return {
      text: [
        "❓ <b>Aiuto</b>",
        "",
        "Scegli un argomento: ogni bottone apre una pagina breve, tre o quattro righe, su una parte della chat.",
        "",
        `<i>${HELP_PAGES.length} argomenti · ogni pagina ha il bottone per andare alla sezione che spiega.</i>`,
      ].join("\n"),
      keyboard: helpKeyboard(HELP_PAGES, null),
    };
  }
  return {
    text: [
      `❓ <b>Aiuto · ${escapeHtml(pagina.title)}</b>`,
      "",
      ...pagina.lines.map((riga) => escapeHtml(riga)),
      "",
      `<i>Argomento ${indice + 1} di ${HELP_PAGES.length}</i>`,
    ].join("\n"),
    keyboard: helpKeyboard(HELP_PAGES, indice),
  };
}

/**
 * 📊 I tuoi numeri: il riepilogo della chat in una schermata.
 *
 * Non è una classifica e non c'è un obiettivo: sono i numeri che si finisce per
 * cercare a mano ("quanto ho recuperato? quante scadenze ho addosso?") messi in
 * un posto solo. Le cifre dei rimborsi restano separate come in 💰 Rimborsi:
 * "recuperati" è denaro tornato, "in attesa" è una promessa.
 */
function numeriScreen(data: ScreenData): Screen {
  const totali = data.refundTotals;
  const righe = [
    "📊 <b>I tuoi numeri</b>",
    "",
    `🗂 In archivio: <b>${data.counts.contestTotal}</b> concorsi · <b>${data.counts.couponTotal}</b> coupon · <b>${data.counts.newsTotal}</b> news`,
    `⭐ Watchlist: <b>${data.counts.salvati}</b> · 🏆 Vinti: <b>${data.counts.vinti}</b> · 🚫 Scartati: <b>${data.counts.ignorati}</b>`,
    `⏳ In scadenza nei prossimi 7 giorni: <b>${data.counts.scadenze}</b>`,
    "",
  ];
  if (totali.received === 0 && totali.pending === 0) {
    righe.push("💰 Rimborsi: nessuna richiesta registrata. Si registra dalla scheda di un coupon.");
  } else {
    righe.push(
      `💰 Rimborsi recuperati: <b>${formatEuro(totali.receivedCents)}</b> in ${quantiRimborsi(totali.received)}`,
      `⏳ In attesa: <b>${formatEuro(totali.pendingCents)}</b> in ${quantiRimborsi(totali.pending)}`,
    );
  }
  righe.push("", "<i>Le decisioni sono di questa chat; l'archivio è condiviso con l'altra persona.</i>");
  return { text: righe.join("\n"), keyboard: numeriKeyboard() };
}

/** "1 rimborso" / "3 rimborsi": il conteggio si legge, non si decifra. */
function quantiRimborsi(n: number): string {
  return n === 1 ? "1 rimborso" : `${n} rimborsi`;
}

/**
 * 💰 I miei rimborsi: quanto denaro è tornato, quanto deve ancora tornare.
 *
 * Le due cifre sono separate di proposito. "Recuperati" sono i soldi che ci sono
 * davvero; "in attesa" è una promessa, e finché non arriva non è un guadagno.
 * I rimborsi senza cifra fissa (una percentuale, un 1+1) non entrano in nessuna
 * delle due somme: il bando non dice quanto, e sommarli a zero li farebbe
 * sembrare recuperati per niente.
 */
function rimborsiScreen(state: UiState, data: ScreenData): Screen {
  const totali = data.refundTotals;
  const pagine = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const page = Math.min(Math.max(data.page, 0), pagine - 1);
  const righe = [
    `💰 <b>I miei rimborsi</b>${data.total > 0 ? ` · ${data.total}` : ""}`,
    "",
  ];

  if (data.total === 0) {
    righe.push(
      "Nessun rimborso registrato.",
      "",
      "Si registra dalla scheda di un coupon: tocca <b>💰 Ho richiesto</b>. Da lì puoi dire quando il denaro è tornato, e qui vedi quanto manca.",
    );
    return { text: righe.join("\n"), keyboard: rimborsiKeyboard([], { index: 0, total: 1 }) };
  }

  // "fino a" sul totale quando qualche importo è un tetto: sommare un massimo
  // come se fosse la cifra esatta è il modo più facile di mentire sui soldi.
  righe.push(
    `✅ ${totali.capReceived > 0 ? "Recuperati fino a" : "Recuperati"}: <b>${formatEuro(totali.receivedCents)}</b> in ${quantiRimborsi(totali.received)}`,
    totali.pending === 0
      ? "⏳ Niente in attesa: hai segnato tutto come ricevuto."
      : `⏳ ${totali.capPending > 0 ? "In attesa fino a" : "In attesa"}: <b>${formatEuro(totali.pendingCents)}</b> in ${quantiRimborsi(totali.pending)}`,
  );
  const senzaCifra = totali.unknownPending + totali.unknownReceived;
  if (senzaCifra > 0) {
    righe.push(
      `ℹ️ ${quantiRimborsi(senzaCifra)} senza cifra fissa (una percentuale o un regalo): il bando non dice quanto, quindi restano fuori dai totali.`,
    );
  }
  if (totali.capPending + totali.capReceived > 0) {
    righe.push(
      `ℹ️ ${quantiRimborsi(totali.capPending + totali.capReceived)} con un tetto ("fino a"): la cifra è il massimo che può tornare, quindi il totale è una stima per eccesso.`,
    );
  }
  righe.push("", "In cima quello che deve ancora tornare. Tocca una riga per segnarlo ricevuto o annullarlo.");
  if (pagine > 1) righe.push(`<i>Pagina ${page + 1}/${pagine}</i>`);

  return {
    text: righe.join("\n"),
    keyboard: rimborsiKeyboard(data.refunds, { index: page, total: pagine }),
  };
}

/**
 * La domanda sull'importo: i bandi che dicono "rimborso del 50%" o "1+1" non
 * dichiarano una cifra, e solo chi ha comprato sa quanto è tornato indietro.
 * Si scrive una volta, in euro, e la richiesta entra nel conteggio.
 */
function importoPromptScreen(data: ScreenData): Screen {
  const item = data.openItem;
  return {
    text: [
      "💰 <b>Quanto ti torna indietro?</b>",
      "",
      item ? `<b>${escapeHtml(truncate(item.title, 90))}</b>` : "",
      "",
      "Il bando non dichiara una cifra fissa: è una percentuale, un 1+1 o un regalo. Scrivi l'importo che ti aspetti di ricevere, per esempio <code>7,50</code>.",
      "Il messaggio con l'importo viene cancellato, come la ricerca.",
    ].join("\n"),
    keyboard: backKeyboard(),
  };
}

/** Compone la schermata corrispondente allo stato della chat. */
export function renderScreen(state: UiState, data: ScreenData, now: Date): Screen {
  const schermata = renderBaseScreen(state, data, now);
  // Ogni sezione che ha una pagina di wiki porta il bottone per aprirla. Prima
  // c'era solo negli elenchi: da ⚙️ Impostazioni o da 🎛 Cosa vedi bisognava
  // tornare al menù e cercare l'argomento, che è esattamente il giro che il
  // bottone doveva risparmiare.
  const pagina = helpPageForSection(state.section);
  if (pagina === null) return schermata;
  const righe = schermata.keyboard.inline_keyboard;
  // Un elenco ce l'ha già (helpRow nel corpo della lista): non si duplica.
  if (righe.some((riga) => riga.some((bottone) => bottone.callback_data === `s:aiuto:${pagina.id}`))) {
    return schermata;
  }
  // Prima dell'ultima riga, che è sempre la coda di navigazione: indietro,
  // aggiorna e menù restano in fondo, dove il pollice li cerca.
  const taglio = Math.max(0, righe.length - 1);
  return {
    ...schermata,
    keyboard: {
      inline_keyboard: [...righe.slice(0, taglio), ...helpRow(pagina), ...righe.slice(taglio)],
    },
  };
}

function renderBaseScreen(state: UiState, data: ScreenData, now: Date): Screen {
  // La domanda sull'importo viene PRIMA della scheda: la sezione è
  // `importo:<id>` e l'offerta è caricata per il titolo, non per essere aperta.
  if (state.section.startsWith("importo:")) return importoPromptScreen(data);
  if (state.openItemId !== null) return cardScreen(state, data, now);

  switch (state.section) {
    case "menu": {
      const righe = ["📡 <b>Concorsi Radar</b>", "", ...headerLines(state, data, now)];
      return { text: righe.join("\n"), keyboard: menuKeyboard(data.counts) };
    }
    case "storico":
      return {
        text: [
          "🗂 <b>Storico</b>",
          "",
          `🏆 <b>${data.counts.vinti}</b> vinti · ⌛ <b>${data.counts.scaduti}</b> chiusi · 🚫 <b>${data.counts.ignorati}</b> scartati · 📚 <b>${data.archiveTotal}</b> in archivio`,
          "",
          "Qui ritrovi quello che hai già visto: i concorsi a cui hai partecipato e vinto, quelli che hanno chiuso e quelli che avevi scartato.",
          "📚 Archivio è un'altra cosa, ed è più grande: è la memoria completa del radar — tutto quello che è passato di qui, compresi i coupon scaduti e quello che non ti è mai stato consegnato.",
        ].join("\n"),
        keyboard: storicoKeyboard({
          vinti: data.counts.vinti,
          scaduti: data.counts.scaduti,
          ignorati: data.counts.ignorati,
          archivio: data.archiveTotal,
        }),
      };
    case "fonti":
      return sourcesScreen(data);
    case "vantaggio":
      return vantaggioScreen(data);
    case "impostazioni":
      return settingsScreen(data);
    case "filtri":
      return filtriScreen(data);
    case "filtri-fonti":
      return filtriFontiScreen(data);
    case "filtri-marche":
      return filtriMarcheScreen(data);
    case "premi":
      return premiScreen(data);
    case "rimborsi":
      return rimborsiScreen(state, data);
    case "preferiti":
      return marcheScreen(data);
    case "diagnostica":
      return diagnosticaScreen(data);
    case "aiuto":
      return helpScreen(data);
    case "numeri":
      return numeriScreen(data);
    case "log":
      return logScreen(data);
    case "cerca":
      return searchPromptScreen();
    default:
      return listScreen(state, data, now);
  }
}
