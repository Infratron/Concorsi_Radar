import type { ItemRow, Prefs, RunRow, SourceRow, UiState } from "../types.ts";
import { CATEGORY_LABELS, isSeeingAll, mutedSourceIds, type FilterSource } from "../filters.ts";
import type { InlineKeyboardMarkup } from "./api.ts";
import { escapeHtml, formatDate, formatItemCard, sourceLabel } from "./format.ts";
import {
  PAGE_SIZE,
  backKeyboard,
  cardKeyboard,
  emptyKeyboard,
  filtriKeyboard,
  filtriFontiKeyboard,
  itemButtonLabel,
  listKeyboard,
  menuKeyboard,
  sectionTitle,
  settingsKeyboard,
  storicoKeyboard,
} from "./keyboard.ts";

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
 * Cosa cambia un tocco nelle impostazioni: le quattro preferenze di sempre più i
 * filtri ("cosa vedi") di QUESTA chat.
 */
export type ConfigKey =
  | "score"
  | "quiet"
  | "digest"
  | "notify"
  | "cat"
  | "tag"
  | "src"
  | "free"
  | "star"
  | "reset";

const CONFIG_KEYS: readonly ConfigKey[] = [
  "score", "quiet", "digest", "notify", "cat", "tag", "src", "free", "star", "reset",
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
  "impostazioni",
  "filtri",
  "filtri-fonti",
] as const;

export function isKnownSection(section: string): boolean {
  return (SECTIONS as readonly string[]).includes(section) || section.startsWith("cerca:");
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
      const section = first.toLowerCase();
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
  /** Concorsi in archivio, di qualunque stato: la metà "buona" dell'archivio. */
  contest: number;
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
  prefs: Prefs;
  archiveTotal: number;
  /** Pagina di fonti da mostrare in 📡 Scegli le fonti (già ritagliata). */
  filterSources: FilterSource[];
  /** Quante fonti si possono spegnere in tutto (per la paginazione). */
  filterSourcesTotal: number;
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
    `🗂 <b>${data.counts.contest}</b> concorsi · <b>${data.counts.news}</b> news in archivio · controllati ${oreMinuti(state.lastCheckAt)}`,
  );
  // Con i filtri accesi il numero di sopra è quello che VEDI, non quello che
  // esiste: senza questa riga l'archivio sembrerebbe più piccolo di com'è.
  if (data.counts.filtri > 0) {
    righe.push(
      `🎛 Filtri tuoi: <b>${data.counts.contest}</b> di <b>${data.counts.contestTotal}</b> concorsi · <b>${data.counts.news}</b> di <b>${data.counts.newsTotal}</b> news`,
    );
  }
  return righe;
}

function listScreen(state: UiState, data: ScreenData, now: Date): Screen {
  const title = sectionTitle(state.section);
  const pagine = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  // Un `page` fuori intervallo (messaggio vecchio, o lista che si è accorciata)
  // non deve mostrare una pagina vuota: si riporta dentro e si ri-renderizza.
  const page = Math.min(Math.max(data.page, 0), pagine - 1);

  // Sostantivo giusto per la sezione: nella news non si "tocca un concorso", e
  // nello storico non si sta guardando qualcosa da fare adesso.
  const nomi: Record<string, [string, string]> = {
    news: ["articolo", "articoli"],
    salvati: ["concorso in watchlist", "concorsi in watchlist"],
    vinti: ["concorso vinto", "concorsi vinti"],
    scaduti: ["concorso chiuso", "concorsi chiusi"],
    ignorati: ["concorso scartato", "concorsi scartati"],
  };
  const [singolare, plurale] = nomi[state.section] ?? ["concorso", "concorsi"];
  if (data.items.length === 0) {
    const vuoti: Record<string, string> = {
      salvati: "La watchlist è vuota: apri un concorso e tocca ⭐ Watchlist per non perderlo di vista.",
      news: "Nessun articolo qui: le news arrivano dalle fonti di cronaca, appena le trovano.",
      vinti: "Nessuna vittoria registrata: quando ne vinci uno, apri la scheda e tocca 🏆 Vinto.",
      scaduti: "Nessun concorso chiuso in archivio: qui finiscono quelli la cui scadenza è passata.",
      ignorati: "Non hai scartato niente: quello che tocchi 🚫 finisce qui, e da qui puoi riprenderlo.",
    };
    const filtrata = data.counts.filtri > 0;
    const righeVuote = [
      `📭 <b>${escapeHtml(title)}</b>`,
      "",
      vuoti[state.section] ?? "Nessun concorso qui. Tocca 🔄 Aggiorna più tardi.",
    ];
    // Un elenco vuoto può voler dire due cose opposte: non c'è niente, oppure i
    // filtri hanno lasciato fuori tutto. Dirlo è la differenza fra "aspetto" e
    // "ho sbagliato un tasto".
    if (filtrata) {
      righeVuote.push("", `🎛 Hai <b>${data.counts.filtri}</b> filtri attivi: può essere per quello.`);
    }
    return { text: righeVuote.join("\n"), keyboard: emptyKeyboard(filtrata) };
  }

  const nome = data.total === 1 ? singolare : plurale;
  const righe = [
    `<b>${escapeHtml(title)}</b> · ${data.total} ${nome}${
      pagine > 1 ? ` · pagina ${page + 1}/${pagine}` : ""
    }`,
    "",
    state.section === "news"
      ? "Qui ci sono gli articoli: il link porta al pezzo, non alla pagina del concorso."
      : state.section === "salvati"
        ? "Ordinati per scadenza: chi chiude prima sta in cima. Ti avviso 3 giorni e 1 giorno prima."
        : "Tocca un concorso per aprirlo:",
  ];
  return {
    text: righe.join("\n"),
    keyboard: listKeyboard(data.items, now, { index: page, total: pagine }, stellePer(data, state.section)),
  };
}

/**
 * Le sezioni dove la soglia delle stelle si mostra: sono quelle che leggono
 * l'archivio per suggerire qualcosa. News ha un punteggio che vuol dire altro,
 * e Watchlist, Storico e Cerca sono scelte esplicite: lì una riga in più sarebbe
 * solo un tasto che non serve.
 */
const SEZIONI_STELLE = new Set(["nuovi", "oggi", "settimana", "scadenze", "scaduti"]);

function stellePer(data: ScreenData, section: string): number | null {
  return SEZIONI_STELLE.has(section) ? data.prefs.filters.minScore : null;
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
    const stato = source.enabled ? "🟢" : "⚪️";
    const ultimo = source.lastOkAt ? oreMinuti(source.lastOkAt) : "mai";
    const errore = source.failStreak > 0 ? ` · ⚠️ ${source.failStreak} di fila` : "";
    righe.push(`${stato} ${escapeHtml(source.name)} · ok ${ultimo}${errore}`);
  }

  if (data.runs.length > 0) {
    righe.push("", "🕒 <b>Ultime raccolte</b>");
    for (const run of data.runs.slice(0, 4)) {
      const origine = run.trigger === "actions" ? "GitHub" : "Worker";
      righe.push(
        `• ${origine} ${oreMinuti(run.startedAt)} · ${run.sourcesOk} ok / ${run.sourcesFail} errori · ${run.itemsNew} nuovi`,
      );
    }
  }
  return { text: righe.join("\n"), keyboard: backKeyboard() };
}

function settingsScreen(data: ScreenData): Screen {
  const { prefs } = data;
  const silenzio = prefs.quietHours.length === 0 ? "nessuno" : `${prefs.quietHours.replace("-", ":00–")}:00`;
  const digest =
    prefs.digestHours.length === 0
      ? "spenti"
      : prefs.digestHours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(" e ");
  const righe = [
    "⚙️ <b>Impostazioni</b>",
    "",
    `🔔 Avvisi immediati: solo sopra <b>${prefs.minScoreInstant}</b>/100`,
    `🌙 Silenzio: <b>${silenzio}</b>`,
    `📬 Digest: <b>${digest}</b>`,
    `📣 Notifiche: <b>${prefs.active ? "attive" : "sospese"}</b>`,
    `🎛 Cosa vedi: <b>${isSeeingAll(prefs.filters) ? "tutto" : `${data.counts.filtri} filtri attivi`}</b>`,
    "",
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
          `🏆 <b>${data.counts.vinti}</b> vinti · ⌛ <b>${data.counts.scaduti}</b> chiusi · 🚫 <b>${data.counts.ignorati}</b> scartati`,
          "",
          "Qui ritrovi quello che hai già visto: i concorsi a cui hai partecipato e vinto, quelli che hanno chiuso e quelli che avevi scartato.",
        ].join("\n"),
        keyboard: storicoKeyboard(data.counts),
      };
    case "fonti":
      return sourcesScreen(data);
    case "impostazioni":
      return settingsScreen(data);
    case "filtri":
      return filtriScreen(data);
    case "filtri-fonti":
      return filtriFontiScreen(data);
    case "cerca":
      return searchPromptScreen();
    default:
      return listScreen(state, data, now);
  }
}
