import type { ItemRow, Prefs, RunRow, SourceRow, UiState } from "../types.ts";
import type { InlineKeyboardMarkup } from "./api.ts";
import { escapeHtml, formatDate, formatItemCard, sourceLabel } from "./format.ts";
import {
  PAGE_SIZE,
  backKeyboard,
  cardKeyboard,
  itemButtonLabel,
  listKeyboard,
  menuKeyboard,
  sectionTitle,
  settingsKeyboard,
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

/** Cosa vuole fare l'utente: i bottoni e i comandi si traducono tutti qui. */
export type Intent =
  | { kind: "home" }
  | { kind: "refresh" }
  | { kind: "section"; section: string }
  | { kind: "page"; page: number }
  | { kind: "open"; itemId: number }
  | { kind: "back" }
  | { kind: "decision"; action: "save" | "ign" | "won"; itemId: number }
  | { kind: "config"; key: "score" | "quiet" | "digest" | "notify"; value: string }
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
  "cerca",
  "fonti",
  "impostazioni",
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
      const key = first;
      const value = rest.slice(1).join(":");
      if (key === "score" || key === "quiet" || key === "digest" || key === "notify") {
        return { kind: "config", key, value };
      }
      return { kind: "none" };
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
  return righe;
}

function listScreen(state: UiState, data: ScreenData, now: Date): Screen {
  const title = sectionTitle(state.section);
  const pagine = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  // Un `page` fuori intervallo (messaggio vecchio, o lista che si è accorciata)
  // non deve mostrare una pagina vuota: si riporta dentro e si ri-renderizza.
  const page = Math.min(Math.max(data.page, 0), pagine - 1);

  // Sostantivo giusto per la sezione: nella news non si "tocca un concorso".
  const articoli = state.section === "news";
  if (data.items.length === 0) {
    const vuoto =
      state.section === "salvati"
        ? "Non hai ancora salvato niente: apri un concorso e tocca ✅ Salva."
        : articoli
          ? "Nessun articolo qui: le news arrivano dalle fonti di cronaca, appena le trovano."
          : "Nessun concorso qui. Tocca 🔄 Aggiorna più tardi.";
    return {
      text: `📭 <b>${escapeHtml(title)}</b>\n\n${vuoto}`,
      keyboard: backKeyboard(),
    };
  }

  const nome =
    data.total === 1 ? (articoli ? "articolo" : "concorso") : articoli ? "articoli" : "concorsi";
  const righe = [
    `<b>${escapeHtml(title)}</b> · ${data.total} ${nome}${
      pagine > 1 ? ` · pagina ${page + 1}/${pagine}` : ""
    }`,
    "",
    articoli
      ? "Qui ci sono gli articoli: il link porta al pezzo, non alla pagina del concorso."
      : "Tocca un concorso per aprirlo:",
  ];
  return {
    text: righe.join("\n"),
    keyboard: listKeyboard(data.items, now, { index: page, total: pagine }),
  };
}

function cardScreen(state: UiState, data: ScreenData, now: Date): Screen {
  const item = data.openItem;
  if (!item) {
    return { text: "🤔 Questo concorso non è più in archivio.", keyboard: backKeyboard() };
  }
  const stato =
    data.decision === "saved"
      ? "✅ <b>Salvato da te</b>"
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
    "",
    "Valgono solo per te: l'altra persona ha le sue.",
  ];
  return { text: righe.join("\n"), keyboard: settingsKeyboard(prefs) };
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
    case "fonti":
      return sourcesScreen(data);
    case "impostazioni":
      return settingsScreen(data);
    case "cerca":
      return searchPromptScreen();
    default:
      return listScreen(state, data, now);
  }
}
