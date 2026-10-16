import type { ItemRow, Prefs, RunRow, SourceRow, UiState } from "../types.ts";
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
import { MAX_MESSAGE_CHARS, type InlineKeyboardMarkup } from "./api.ts";
import { escapeHtml, formatDate, formatItemCard, sourceLabel } from "./format.ts";
import { esitoUltimoTentativo } from "./report.ts";
import { truncate } from "../lib/text.ts";
import { runOrigin } from "../schedule.ts";
import {
  BRANDS_PAGE_SIZE,
  PAGE_SIZE,
  archivioKeyboard,
  backKeyboard,
  cardKeyboard,
  diagnosticaKeyboard,
  emptyKeyboard,
  filtriKeyboard,
  filtriFontiKeyboard,
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
  | { kind: "decision"; action: "save" | "ign" | "won"; itemId: number }
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
  "preferiti",
  "preferiti-lista",
  "coupon",
  "gratis",
  "premi",
  "archivio",
  "diagnostica",
  "log",
] as const;

export function isKnownSection(section: string): boolean {
  if ((SECTIONS as readonly string[]).includes(section)) return true;
  if (section.startsWith("cerca:")) return true;
  // `archivio:<tipo>` si accetta solo per i tre tipi veri: una sezione inventata
  // non leggerebbe niente, mentre un tipo sbagliato letto come "tutto" darebbe
  // l'elenco completo credendo di averne chiesto una fetta (vedi archivioKindFor).
  if (section.startsWith("archivio:")) return archivioKindFor(section) !== null;
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
    case "ign":
    case "won": {
      const itemId = Number.parseInt(first, 10);
      if (!Number.isFinite(itemId)) return { kind: "none" };
      return { kind: "decision", action: head === "save" ? "save" : head === "ign" ? "ign" : "won", itemId };
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
 * Applica l'intento allo stato. È pura: le preferenze, le query e il momento in
 * cui il contatore dei "nuovi" riparte stanno in bot.ts (che deve leggere la
 * sezione *prima* di segnarla come vista, altrimenti l'elenco uscirebbe vuoto).
 */
export function applyIntent(state: UiState, intent: Intent, now: Date): UiState {
  void now;
  switch (intent.kind) {
    case "home":
      return { ...state, section: "menu", page: 0, openItemId: null };
    case "refresh":
      return state;
    case "section":
      return { ...state, section: intent.section, page: 0, openItemId: null };
    case "page":
      return { ...state, page: intent.page, openItemId: null };
    case "open":
      return { ...state, openItemId: intent.itemId };
    case "back":
      return { ...state, openItemId: null };
    case "decision":
      return { ...state, openItemId: intent.itemId };
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
  /** Coupon e rimborsi in archivio, senza filtri: serve a dire "vedi X di Y". */
  couponTotal: number;
  /** Concorsi in archivio, di qualunque stato: la metà "buona" dell'archivio. */
  contest: number;
  /** Concorsi delle marche seguite, con i filtri della chat: è il numero sul bottone. */
  preferiti: number;
  /**
   * Concorsi senza obbligo di acquisto (🆓 Gratis), con i filtri della chat.
   * Nasce dalla stessa query della sezione, quindi il numero sul bottone e
   * l'elenco non possono raccontare due cose diverse.
   */
  gratis: number;
  /**
   * Quanti concorsi aprirebbe ciascuna porta di 🎁 Tipi di premio, per sezione
   * ("premi:giftcard", "gratis"…). Si contano solo aprendo quella schermata:
   * cinque query per un menù che non li mostra sarebbero lavoro per niente.
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
  sources: SourceRow[];
  runs: RunRow[];
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
  /** Pagina di marche da mostrare in 🏷 Preferiti per marca (già ritagliata). */
  brandChoices: BrandChoice[];
  /** Quante marche ha il registro in tutto (per la paginazione). */
  brandChoicesTotal: number;
}

function oreMinuti(iso: string | null): string {
  if (!iso) return "mai";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "mai";
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
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
    `🗂 <b>${data.counts.contest}</b> concorsi · <b>${data.counts.coupon}</b> coupon · <b>${data.counts.news}</b> news in archivio · controllati ${oreMinuti(state.lastCheckAt)}`,
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
  const chiave = sezioneArchivio ? "archivio" : state.section;
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
        "Non segui ancora nessuna marca, quindi non c'è niente da mostrare qui: aprine una in 🏷 Preferiti per marca.",
      coupon:
        "Nessun coupon valido adesso: qui restano solo quelli ancora spendibili — i buoni scaduti sono in 📚 Archivio — e i nuovi arrivano appena le fonti li trovano.",
      gratis:
        "Nessun concorso senza acquisto qui: per ora tutti quelli in archivio chiedono uno scontrino, un codice o una spesa minima.",
      archivio:
        "L'archivio è vuoto: qui finisce tutto quello che il bot ha visto e vedrà, quindi si riempie alla prima raccolta.",
      ...Object.fromEntries(
        PRIZE_QUICK_FILTERS.filter((voce) => voce.tag !== null).map((voce) => [
          voce.section,
          `Nessun concorso con ${voce.label.toLowerCase()} in palio adesso: il tipo lo decide quello che la pagina dichiara, e in questo momento nessun concorso dell'archivio lo dichiara.`,
        ]),
      ),
    };
    // Nell'archivio i filtri non contano (si vede tutto per definizione):
    // attribuire a loro un elenco vuoto sarebbe la spiegazione sbagliata.
    const filtrata = data.counts.filtri > 0 && !sezioneArchivio;
    const righeVuote = [
      `📭 <b>${escapeHtml(title)}</b>`,
      "",
      vuoti[chiave] ?? "Nessun concorso qui. Tocca 🔄 Aggiorna più tardi.",
    ];
    // Un elenco vuoto può voler dire due cose opposte: non c'è niente, oppure i
    // filtri hanno lasciato fuori tutto. Dirlo è la differenza fra "aspetto" e
    // "ho sbagliato un tasto".
    if (filtrata) {
      righeVuote.push("", `🎛 Hai <b>${data.counts.filtri}</b> filtri attivi: può essere per quello.`);
    }
    return {
      text: righeVuote.join("\n"),
      keyboard: emptyKeyboard(filtrata, state.section === "preferiti-lista"),
    };
  }

  const nome = data.total === 1 ? singolare : plurale;
  const righe = [
    `<b>${escapeHtml(title)}</b> · ${data.total} ${nome}${
      pagine > 1 ? ` · pagina ${page + 1}/${pagine}` : ""
    }`,
    "",
    state.section === "news"
      ? "Qui ci sono gli articoli: il link porta al pezzo, non alla pagina del concorso."
      : state.section === "coupon"
        ? "Qui ci sono i buoni sconto e i rimborsi: si spende meno, non si vince. Non finiscono nei concorsi né negli avvisi."
        : state.section === "gratis"
        ? "Qui ci sono solo i concorsi senza acquisto: nessuno scontrino, nessun codice da comprare, nessuna spesa minima. Il giudizio viene da quello che la pagina dichiara — se non dice niente, il concorso resta in elenco."
        : state.section.startsWith("premi:")
        ? "Qui ci sono solo i concorsi di questo tipo: il premio lo legge l'arricchimento dal testo della pagina, quindi un concorso lo trovi qui se lo dichiara. Per gli altri resta tutto come prima: questa porta non accende nessun filtro."
        : state.section === "salvati"
        ? "Ordinati per scadenza: chi chiude prima sta in cima. Ti avviso 3 giorni e 1 giorno prima — e molto prima per le raccolte punti e i premi da richiedere, dove scontrini e bollini si mettono via durante la raccolta."
        : state.section === "preferiti-lista"
          ? "Solo le marche che segui, dal punteggio più alto: è il motivo per cui le trovi qui in cima."
        : sezioneArchivio
          ? "Tutto quello che è passato da qui, dal più recente: concorsi chiusi e coupon scaduti compresi, marcati ⛔. I filtri di 🎛 Cosa vedi non valgono in archivio — se l'abbiamo visto, si trova."
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
      : listKeyboard(data.items, now, { index: page, total: pagine }, stellePer(data, state.section)),
  };
}

/**
 * Le sezioni dove la soglia delle stelle si mostra: sono quelle che leggono
 * l'archivio per suggerire qualcosa. News ha un punteggio che vuol dire altro,
 * e Watchlist, Storico e Cerca sono scelte esplicite: lì una riga in più sarebbe
 * solo un tasto che non serve.
 */
const SEZIONI_STELLE = new Set([
  "nuovi", "oggi", "settimana", "scadenze", "scaduti", "preferiti-lista", "gratis",
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

  const righe: string[] = [];
  if (stato) righe.push(stato, "");
  righe.push(formatItemCard(item, now));
  // Il vantaggio misurato su QUESTO concorso: è la riga che rende il numero del
  // comando /vantaggio verificabile caso per caso.
  if (data.leadDelConcorso !== null) {
    righe.push(
      data.leadDelConcorso > 0.5
        ? `🏁 Visto <b>${durata(data.leadDelConcorso)}</b> prima degli aggregatori`
        : data.leadDelConcorso < -0.5
          ? `🏁 Gli aggregatori l'hanno visto <b>${durata(data.leadDelConcorso)}</b> prima`
          : "🏁 Visto dagli aggregatori nello stesso giro",
    );
  }
  righe.push(`🆔 <code>${item.id}</code> · 📥 fonte: ${escapeHtml(sourceLabel(item.sourceId))}`);
  return {
    text: righe.join("\n"),
    keyboard: cardKeyboard(item, data.decision, data.regolamentoUrl),
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
 * 🏷 Preferiti per marca: l'elenco delle marche da seguire, con quanti concorsi
 * ha ciascuna in archivio. È una schermata di scelte, quindi dice cosa cambia
 * accendere una marca — un punteggio più alto e una sezione sua — invece di
 * lasciarlo scoprire toccando.
 */
function marcheScreen(data: ScreenData): Screen {
  const { prefs } = data;
  const seguite = prefs.filters.favoriteBrands;
  const pagine = Math.max(1, Math.ceil(data.brandChoicesTotal / BRANDS_PAGE_SIZE));
  const page = Math.min(Math.max(data.page, 0), pagine - 1);
  const righe = [
    "🏷 <b>Preferiti per marca</b>",
    "",
    "✅ la segui · ⬜️ no. Una marca che segui <b>vale 10 punti in più</b> e ha la sua sezione: l'elenco qui sotto è ordinato da chi ha più concorsi in archivio.",
    "",
    seguite.length === 0
      ? "Non ne segui ancora nessuna."
      : `Segui <b>${seguite.length}</b> ${seguite.length === 1 ? "marca" : "marche"}: ${escapeHtml(
          seguite.map((id) => brandLabel(id)).join(", "),
        )} — <b>${data.counts.preferiti}</b> concorsi in archivio.`,
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
 * 🎁 Tipi di premio: cinque porte, una per tipo di premio.
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

/** Compone la schermata corrispondente allo stato della chat. */
export function renderScreen(state: UiState, data: ScreenData, now: Date): Screen {
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
    case "premi":
      return premiScreen(data);
    case "preferiti":
      return marcheScreen(data);
    case "diagnostica":
      return diagnosticaScreen(data);
    case "log":
      return logScreen(data);
    case "cerca":
      return searchPromptScreen();
    default:
      return listScreen(state, data, now);
  }
}
