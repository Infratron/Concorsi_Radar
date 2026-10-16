import type { ItemRow, Prefs } from "../types.ts";
import { truncate } from "../lib/text.ts";
import { CATEGORY_LABELS, STAR_CHOICES, TAG_FILTERS, categoriesToOffer, starLabel, type FilterSource } from "../filters.ts";
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
  /** Quanti filtri sono attivi: 0 = si vede tutto. */
  filtri: number;
}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(`🆕 Nuovi (${counts.nuovi})`, "s:nuovi"), button(`📋 Oggi (${counts.oggi})`, "s:oggi")],
      [button(`📅 7 giorni (${counts.settimana})`, "s:settimana"), button(`⏳ Scadenze (${counts.scadenze})`, "s:scadenze")],
      [button(`⭐ Watchlist (${counts.salvati})`, "s:salvati"), button(`📰 News (${counts.news})`, "s:news")],
      [button("🔍 Cerca", "s:cerca"), button("🗂 Storico", "s:storico")],
      [button(filtriButtonLabel(counts.filtri), "s:filtri"), button("📡 Fonti", "s:fonti")],
      [button("⚙️ Impostazioni", "s:impostazioni")],
      [button("🔄 Aggiorna", "refresh")],
    ],
  };
}

/**
 * Etichetta del bottone dei filtri: il numero dice a colpo d'occhio che l'elenco
 * che stai guardando NON è tutto l'archivio.
 */
export function filtriButtonLabel(quanti: number): string {
  return quanti === 0 ? "🎛 Cosa vedi" : `🎛 Cosa vedi (${quanti})`;
}

/** Nome leggibile e corto di una fonte: in un bottone ci sta una riga sola. */
export function sourceToggleLabel(source: FilterSource, muted: boolean): string {
  const [testa, coda] = source.name.split("·").map((part) => part.trim());
  const nome = coda && coda.length > 0 ? `${testa ?? ""} · ${coda}` : (testa ?? source.name);
  return `${muted ? "🚫" : "✅"} ${truncate(nome, 40)}`;
}

/**
 * 🎛 Cosa vedi: filtri personali della chat. Ogni riga è un interruttore — ✅
 * mostra, 🚫 nasconde — e non c'è nessuna voce "altro": quello che non è
 * spento si vede, comprese le fonti che arriveranno domani.
 */
export function filtriKeyboard(prefs: Prefs, info: { sources: number; spenti: number }): InlineKeyboardMarkup {
  const filtro = prefs.filters;
  const righe: InlineKeyboardButton[][] = [];

  // Tipi di concorso: due per riga, sono etichette corte.
  const tipi = TAG_FILTERS.map((entry) =>
    button(`${filtro.mutedTags.includes(entry.tag) ? "🚫" : "✅"} ${entry.label}`, `cfg:tag:${entry.tag}`),
  );
  for (let index = 0; index < tipi.length; index += 2) righe.push(tipi.slice(index, index + 2));

  // Categorie delle fonti: dove si partecipa (online, punto vendita, scontrino…).
  const categorie = categoriesToOffer().map((categoria) =>
    button(
      `${filtro.mutedCategories.includes(categoria) ? "🚫" : "✅"} ${CATEGORY_LABELS[categoria]}`,
      `cfg:cat:${categoria}`,
    ),
  );
  for (let index = 0; index < categorie.length; index += 2) righe.push(categorie.slice(index, index + 2));

  righe.push([
    filtro.freeOnly
      ? button("🎁 Solo senza acquisto: sì", "cfg:free:off")
      : button("🎁 Solo senza acquisto: no", "cfg:free:on"),
  ]);
  righe.push(starKeyboard(filtro.minScore));
  righe.push([button(`📡 Scegli le fonti (${info.sources - info.spenti}/${info.sources})`, "s:filtri-fonti")]);
  return { inline_keyboard: [...righe, ...navRows()] };
}

/**
 * 📡 Scegli le fonti: un interruttore per fonte, a pagine (sono più di venti).
 * La pagina vive nello stato della chat, quindi si sfoglia come gli elenchi.
 */
export function filtriFontiKeyboard(
  sources: FilterSource[],
  muted: string[],
  pagina: { index: number; total: number },
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = sources.map((source) => [
    button(sourceToggleLabel(source, muted.includes(source.id)), `cfg:src:${source.id}`),
  ]);
  if (pagina.total > 1) {
    rows.push([
      pagina.index > 0 ? button("⬅️ Prec", `page:${pagina.index - 1}`) : done("⬅️"),
      done(`${pagina.index + 1}/${pagina.total}`),
      pagina.index < pagina.total - 1 ? button("Succ ➡️", `page:${pagina.index + 1}`) : done("➡️"),
    ]);
  }
  rows.push([button("♻️ Vedi di nuovo tutto", "cfg:reset:all")]);
  rows.push([button("⬅️ Cosa vedi", "s:filtri"), button("🏠 Menù", "home")]);
  return { inline_keyboard: rows };
}

/** Aggiorna + menù: la coda standard di ogni schermata. */
function navRows(): InlineKeyboardButton[][] {
  return [[button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")]];
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
 * La riga delle stelle: un tocco per dire "solo quelli che valgono", senza
 * aprire nessun menù. Sta sopra la navigazione, è una riga sola, e il pallino
 * dice quale soglia è attiva: l'elenco è già ordinato dal punteggio più alto,
 * quindi alzare la soglia vuol dire tenere la testa della classifica.
 */
export function starKeyboard(attiva: number): InlineKeyboardButton[] {
  return STAR_CHOICES.map((soglia) =>
    button(attiva === soglia ? `• ${starLabel(soglia)}` : starLabel(soglia), `cfg:star:${soglia}`),
  );
}

/**
 * Elenco: un bottone per concorso (così si tocca direttamente quello che
 * interessa) più la navigazione. `nav` compare solo quando c'è più di una pagina.
 */
export function listKeyboard(
  items: ItemRow[],
  now: Date,
  pagina: { index: number; total: number },
  /** Soglia attiva, oppure null dove le stelle non hanno senso (news, storico). */
  stelleMinime: number | null = null,
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
  if (stelleMinime !== null) rows.push(starKeyboard(stelleMinime));
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
      [button("🎛 Cosa vedi", "s:filtri")],
      [button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")],
    ],
  };
}

/** Schermate senza scelte: solo il ritorno (fonti, prompt della ricerca, errori). */
export function backKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")]] };
}

/**
 * Elenco vuoto. Se la chat ha dei filtri attivi la strada per tornare indietro
 * deve stare lì: "non c'è niente" e "hai spento tu le fonti" sono due cose
 * diverse, e senza questo bottone la seconda sembra la prima.
 */
export function emptyKeyboard(conFiltri: boolean): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  if (conFiltri) rows.push([button("🎛 Cosa vedi", "s:filtri")]);
  return { inline_keyboard: [...rows, ...navRows()] };
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
    case "filtri":
      return "Cosa vedi";
    case "filtri-fonti":
      return "Scegli le fonti";
    case "cerca":
      return "Cerca";
    default:
      return "Concorsi Radar";
  }
}
