import type { ItemRow, Prefs } from "../types.ts";
import { truncate } from "../lib/text.ts";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./api.ts";
import { daysLeft } from "./format.ts";

/**
 * Tastiere del bot. Il bot si guida con i bottoni, non con i comandi: il menù
 * principale porta a una sezione, ogni sezione a una scheda, e da lì si torna
 * indietro. I `callback_data` sono corti e stabili — li legge src/telegram/bot.ts,
 * che li interpreta come intenti (vedi Intent in screens.ts).
 *
 * Regola di Telegram: al massimo 64 byte per callback_data. Per questo i dati
 * non contengono mai testo libero: lo stato (sezione, pagina, scheda aperta) sta
 * nel database, in `ui`. Le sezioni le riporta src/telegram/bot.ts dopo aver
 * letto lo stato, quindi ogni bottone resta valido a prescindere da dove si era.
 */

export const PAGE_SIZE = 6;

function button(text: string, callback_data: string): InlineKeyboardButton {
  return { text, callback_data };
}

/** Bottone "già fatto": nessuna azione, serve solo a mostrare lo stato. */
function done(text: string): InlineKeyboardButton {
  return button(text, "noop");
}

/**
 * Etichetta di un concorso in un elenco: punteggio, urgenza e titolo. Il titolo
 * è troncato perché Telegram tronca da sé, e vogliamo decidere noi dove.
 */
export function itemButtonLabel(item: ItemRow, now: Date): string {
  const left = daysLeft(item.deadline, now);
  const urgenza = left !== null && left >= 0 && left <= 7 ? ` ⏳${left}gg` : "";
  // 📰 invece di ⭐: in un elenco (e nella ricerca, dove i due tipi convivono) si
  // vede subito che quello è un articolo che parla del concorso, non la pagina
  // su cui si partecipa.
  const segno = item.kind === "news" ? "📰" : "⭐";
  return truncate(`${segno}${item.score}${urgenza} · ${item.title}`, 52);
}

/** Il menù principale: tutte le sezioni, con i conteggi addosso. */
export function menuKeyboard(counts: {
  nuovi: number;
  oggi: number;
  settimana: number;
  scadenze: number;
  salvati: number;
  news: number;
}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(`🆕 Nuovi (${counts.nuovi})`, "s:nuovi"), button(`📋 Oggi (${counts.oggi})`, "s:oggi")],
      [button(`📅 7 giorni (${counts.settimana})`, "s:settimana"), button(`⏳ Scadenze (${counts.scadenze})`, "s:scadenze")],
      [button(`⭐ Watchlist (${counts.salvati})`, "s:salvati"), button(`📰 News (${counts.news})`, "s:news")],
      [button("🔍 Cerca", "s:cerca"), button("🗂 Storico", "s:storico")],
      [button("📡 Fonti", "s:fonti"), button("⚙️ Impostazioni", "s:impostazioni")],
      [button("🔄 Aggiorna", "refresh")],
    ],
  };
}

/**
 * Lo storico: cosa è successo ai concorsi che hai visto. È un sotto-menù perché
 * sono tre elenchi che si guardano di rado, e nel menù principale ruberebbero lo
 * spazio a quelli che si guardano ogni giorno.
 */
export function storicoKeyboard(counts: {
  vinti: number;
  scaduti: number;
  ignorati: number;
}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(`🏆 Vinti (${counts.vinti})`, "s:vinti"), button(`⌛ Scaduti (${counts.scaduti})`, "s:scaduti")],
      [button(`🚫 Ignorati (${counts.ignorati})`, "s:ignorati"), button("🏠 Menù", "home")],
      [button("🔄 Aggiorna", "refresh")],
    ],
  };
}

/**
 * Elenco: un bottone per concorso (così si tocca direttamente quello che
 * interessa) più la navigazione. `nav` compare solo quando c'è più di una pagina.
 */
export function listKeyboard(
  items: ItemRow[],
  now: Date,
  pagina: { index: number; total: number },
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = items.map((item) => [
    button(itemButtonLabel(item, now), `open:${item.id}`),
  ]);

  if (pagina.total > 1) {
    rows.push([
      pagina.index > 0 ? button("⬅️ Prec", `page:${pagina.index - 1}`) : done("⬅️"),
      done(`${pagina.index + 1}/${pagina.total}`),
      pagina.index < pagina.total - 1 ? button("Succ ➡️", `page:${pagina.index + 1}`) : done("➡️"),
    ]);
  }
  rows.push([button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")]);
  return { inline_keyboard: rows };
}

/**
 * Scheda di un concorso: le tre decisioni (il tipo già scelto resta visibile ma
 * inerte), i link e il ritorno all'elenco da cui si è arrivati.
 */
export function cardKeyboard(
  item: ItemRow,
  decision: string | null,
  regolamentoUrl: string | null,
): InlineKeyboardMarkup {
  const decisioni: InlineKeyboardButton[] = [
    decision === "saved" ? done("⭐ In watchlist") : button("⭐ Watchlist", `save:${item.id}`),
    decision === "ignored" ? done("🚫 Ignorato") : button("🚫 Non mi interessa", `ign:${item.id}`),
    decision === "won" ? done("🏆 Vinto") : button("🏆 Vinto", `won:${item.id}`),
  ];

  const link: InlineKeyboardButton[] = [{ text: "🔗 Apri", url: item.url }];
  if (regolamentoUrl) link.push({ text: "📄 Regolamento", url: regolamentoUrl });

  return {
    inline_keyboard: [
      decisioni,
      link,
      [button("⬅️ Torna all'elenco", "back"), button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")],
    ],
  };
}

/** Bottoni sotto un avviso immediato: decide e apre il menù, senza lasciare il messaggio lì. */
export function instantKeyboard(item: ItemRow, regolamentoUrl: string | null): InlineKeyboardMarkup {
  const link: InlineKeyboardButton[] = [{ text: "🔗 Apri", url: item.url }];
  if (regolamentoUrl) link.push({ text: "📄 Regolamento", url: regolamentoUrl });
  return {
    inline_keyboard: [
      [
        button("⭐ Watchlist", `save:${item.id}`),
        button("🚫 Non mi interessa", `ign:${item.id}`),
        button("🏆 Vinto", `won:${item.id}`),
      ],
      link,
      [button("🏠 Menù", "home")],
    ],
  };
}

/**
 * Bottoni del digest: un concorso per riga, più il ritorno al menù. I
 * callback_data hanno il prefisso `d:`: dicono al router che questo messaggio
 * NON va cancellato dopo l'uso (il digest è contenuto da rileggere, mentre un
 * avviso immediato ha già fatto il suo lavoro appena lo tocchi).
 */
export function digestKeyboard(items: ItemRow[], now: Date): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = items.map((item) => [
    button(itemButtonLabel(item, now), `d:open:${item.id}`),
  ]);
  rows.push([button("🏠 Menù", "d:home")]);
  return { inline_keyboard: rows };
}

/** Soglie proposte per gli avvisi immediati (punteggio minimo). */
export const SCORE_CHOICES = [60, 70, 80, 90];
/** Fasce di silenzio pronte all'uso: "off" = nessun silenzio. */
export const QUIET_CHOICES = ["23-7", "22-8", "off"];
/** Orari dei digest pronti all'uso: "off" = digest spenti. */
export const DIGEST_CHOICES = ["8,19", "7,13,20", "off"];

/** Impostazioni: ogni riga cambia una preferenza, quella attiva è marcata con •. */
export function settingsKeyboard(prefs: Prefs): InlineKeyboardMarkup {
  const score = SCORE_CHOICES.map((value) =>
    button(prefs.minScoreInstant === value ? `• ${value}` : String(value), `cfg:score:${value}`),
  );
  const quiet = QUIET_CHOICES.map((value) =>
    button(prefs.quietHours === value || (value === "off" && prefs.quietHours === "")
      ? `• ${value === "off" ? "Off" : value.replace("-", "–")}`
      : value === "off" ? "Off" : value.replace("-", "–"), `cfg:quiet:${value}`),
  );
  const digestValue = prefs.digestHours.length === 0 ? "off" : prefs.digestHours.join(",");
  const digest = DIGEST_CHOICES.map((value) =>
    button(digestValue === value ? `• ${value === "off" ? "Off" : value.replace(/,/g, " + ")}` : value === "off" ? "Off" : value.replace(/,/g, " + "), `cfg:digest:${value}`),
  );

  return {
    inline_keyboard: [
      score,
      quiet,
      digest,
      [prefs.active ? button("⏸ Sospendi notifiche", "cfg:notify:off") : button("▶️ Riattiva notifiche", "cfg:notify:on")],
      [button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")],
    ],
  };
}

/** Schermate senza scelte: solo il ritorno (fonti, prompt della ricerca, errori). */
export function backKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")]] };
}

/** Testo leggibile della sezione, per l'intestazione delle schermate. */
export function sectionTitle(section: string): string {
  if (section.startsWith("cerca:")) return `Ricerca: ${section.slice("cerca:".length)}`;
  switch (section) {
    case "nuovi":
      return "Nuovi dall'ultimo controllo";
    case "oggi":
      return "Ultime 24 ore";
    case "settimana":
      return "Ultimi 7 giorni";
    case "scadenze":
      return "In scadenza";
    case "salvati":
      return "Watchlist";
    case "storico":
      return "Storico";
    case "vinti":
      return "Concorsi vinti";
    case "scaduti":
      return "Concorsi chiusi";
    case "ignorati":
      return "Scartati da te";
    case "news":
      return "Articoli e news";
    case "fonti":
      return "Fonti e raccolte";
    case "impostazioni":
      return "Impostazioni";
    case "cerca":
      return "Cerca";
    default:
      return "Concorsi Radar";
  }
}
