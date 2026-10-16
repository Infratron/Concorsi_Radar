import type { ItemRow, Prefs } from "../types.ts";
import type { BrandChoice } from "../config/brands.ts";
import { truncate } from "../lib/text.ts";
import { CATEGORY_LABELS, STAR_CHOICES, TAG_FILTERS, categoriesToOffer, starLabel, type FilterSource } from "../filters.ts";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./api.ts";
import { daysLeft } from "./format.ts";
import { DIGEST_HOURS, hourLabel, hourShort, quietRange, shiftQuietRange, stepScore } from "./prefs-config.ts";

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
/**
 * Marche per pagina: due per riga, perché queste etichette sono corte ("Ferrero")
 * e con un bottone per riga la schermata diventerebbe lunga come l'elenco fonti.
 * Il registro è di una trentina di voci, quindi tre pagine.
 */
export const BRANDS_PAGE_SIZE = 12;

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
  // 📰 per un articolo e 💶 per un coupon, al posto di ⭐: in un elenco (e nella
  // ricerca, dove i tre tipi convivono) si vede subito che quello non è la pagina
  // su cui si partecipa.
  //
  // Il coupon non porta il punteggio: il punteggio risponde a "quanto vale la
  // pena guardare questo concorso adesso" (premio, sforzo, scadenza) e su un
  // buono sconto non vuol dire niente — mostrarlo sarebbe un numero inventato.
  const segno = item.kind === "news" ? "📰" : item.kind === "coupon" ? "💶" : "⭐";
  const testa = item.kind === "coupon" ? segno : `${segno}${item.score}`;
  return truncate(`${testa}${urgenza} · ${item.title}`, 52);
}

/** Il menù principale: tutte le sezioni, con i conteggi addosso. */
export function menuKeyboard(counts: {
  nuovi: number;
  oggi: number;
  settimana: number;
  scadenze: number;
  salvati: number;
  news: number;
  /** Coupon e rimborsi in archivio: è il numero sul bottone 💶. */
  coupon: number;
  /** Concorsi delle marche seguite: è il numero che sta sul bottone dei preferiti. */
  preferiti: number;
  /** Quanti filtri sono attivi: 0 = si vede tutto. */
  filtri: number;
}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(`🆕 Nuovi (${counts.nuovi})`, "s:nuovi"), button(`📋 Oggi (${counts.oggi})`, "s:oggi")],
      [button(`📅 7 giorni (${counts.settimana})`, "s:settimana"), button(`⏳ Scadenze (${counts.scadenze})`, "s:scadenze")],
      [button(`⭐ Watchlist (${counts.salvati})`, "s:salvati"), button(`📰 News (${counts.news})`, "s:news")],
      [button("🔍 Cerca", "s:cerca"), button("🗂 Storico", "s:storico")],
      // Le offerte su una riga tutta loro: non sono concorsi e non stanno in
      // mezzo ai concorsi, ma devono restare a un tocco dal menù.
      [button(`💶 Coupon e rimborsi (${counts.coupon})`, "s:coupon")],
      [button(`🏷 Preferiti per marca (${counts.preferiti})`, "s:preferiti"), button(filtriButtonLabel(counts.filtri), "s:filtri")],
      [button("📡 Fonti", "s:fonti"), button("⚙️ Impostazioni", "s:impostazioni")],
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
  righe.push([button(`🏷 Preferiti per marca (${filtro.favoriteBrands.length})`, "s:preferiti")]);
  righe.push([button(`📡 Scegli le fonti (${info.sources - info.spenti}/${info.sources})`, "s:filtri-fonti")]);
  return { inline_keyboard: [...righe, ...navRows()] };
}

/**
 * 🏷 Preferiti per marca: l'elenco delle marche da seguire. Ogni bottone è un
 * interruttore (✅ la segui · ⬜️ no) con il numero di concorsi che ha in
 * archivio, così si vede subito quali marche contano davvero.
 *
 * I bottoni che non fanno nulla (il filtro senza marche da seguire, la lista
 * vuota) restano scritti ma inerti: una riga che sparisce sposta tutte le altre,
 * e in una schermata da toccare con il pollice è peggio di un bottone spento.
 */
export function marcheKeyboard(
  scelte: BrandChoice[],
  info: { seguite: number; brandsOnly: boolean; page: { index: number; total: number } },
): InlineKeyboardMarkup {
  const righe: InlineKeyboardButton[][] = [];
  const bottoni = scelte.map((scelta) =>
    button(`${scelta.followed ? "✅" : "⬜️"} ${scelta.label} (${scelta.count})`, `cfg:brand:${scelta.id}`),
  );
  for (let index = 0; index < bottoni.length; index += 2) righe.push(bottoni.slice(index, index + 2));

  if (info.page.total > 1) {
    righe.push([
      info.page.index > 0 ? button("⬅️ Prec", `page:${info.page.index - 1}`) : done("⬅️"),
      done(`${info.page.index + 1}/${info.page.total}`),
      info.page.index < info.page.total - 1 ? button("Succ ➡️", `page:${info.page.index + 1}`) : done("➡️"),
    ]);
  }

  // Il filtro vero: "solo le marche che seguo". Senza nessuna marca seguìta non
  // filtrerebbe niente, quindi il bottone è inerte finché l'elenco è vuoto.
  if (info.seguite === 0) {
    righe.push([done("🌟 Solo le marche seguite: —")]);
  } else {
    righe.push([
      info.brandsOnly
        ? button("🌟 Solo le marche seguite: sì", "cfg:brands:off")
        : button("🌟 Solo le marche seguite: no", "cfg:brands:on"),
    ]);
    righe.push([button("📋 I loro concorsi", "s:preferiti-lista"), button("🧹 Svuota", "cfg:brands:reset")]);
  }
  righe.push([button("🎛 Cosa vedi", "s:filtri"), button("🏠 Menù", "home")]);
  return { inline_keyboard: righe };
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
/** Ore per riga nella griglia del digest: 24 bottoni in quattro righe. */
const ORE_PER_RIGA = 6;

function labelQuiet(value: string): string {
  return value === "off" ? "Off" : value.replace("-", "–");
}

function labelDigest(value: string): string {
  return value === "off" ? "Off" : value.replace(/,/g, " + ");
}

/**
 * Impostazioni: ogni riga cambia una preferenza, quella attiva è marcata con •.
 *
 * Le tre cose che si regolano hanno due modi per farlo, e la differenza è voluta:
 * le voci in fondo a ogni gruppo sono i valori soliti (un tocco e via), i ➖ ➕
 * servono invece a spostarsi di poco — una soglia a 85, un silenzio che comincia
 * alle 0 invece che alle 23, un digest alle 9 invece che alle 8. Prima si poteva
 * solo scegliere fra due o tre combinazioni decise da noi.
 *
 * La fascia di silenzio ha DUE cursori: allungarla (23 → 22, che è il caso
 * normale) non è la stessa cosa che spostarla, e con un cursore solo se ne poteva
 * fare una delle due. Gli orari del digest sono 24 interruttori, perché "il
 * digest alle 9" non è un gruppo da scegliere ma un'ora da accendere.
 */
export function settingsKeyboard(prefs: Prefs): InlineKeyboardMarkup {
  const righe: InlineKeyboardButton[][] = [];

  // 🔔 Soglia degli avvisi immediati. Ai bordi (0 e 100) il cursore diventa
  // inerte invece di sparire: la riga resta leggibile e non si sposta.
  const sotto = stepScore(prefs.minScoreInstant, -1);
  const sopra = stepScore(prefs.minScoreInstant, 1);
  righe.push([
    sotto < prefs.minScoreInstant ? button("➖ 5", `cfg:score:${sotto}`) : done("➖"),
    done(`🔔 ${prefs.minScoreInstant}/100`),
    sopra > prefs.minScoreInstant ? button("➕ 5", `cfg:score:${sopra}`) : done("➕"),
  ]);
  righe.push(
    SCORE_CHOICES.map((value) =>
      button(prefs.minScoreInstant === value ? `• ${value}` : String(value), `cfg:score:${value}`),
    ),
  );

  // 🌙 Fascia di silenzio. Con il silenzio spento i cursori partono dalla fascia
  // solita e lo accendono: chi tocca ➖ ➕ vuole una fascia, e "Off" resta a un
  // tocco di distanza per disfarlo.
  const fascia = quietRange(prefs);
  righe.push([
    button("➖ 1h", `cfg:quiet:${shiftQuietRange(fascia, "start", -1)}`),
    done(`🌙 dalle ${hourLabel(fascia.start)}`),
    button("➕ 1h", `cfg:quiet:${shiftQuietRange(fascia, "start", 1)}`),
  ]);
  righe.push([
    button("➖ 1h", `cfg:quiet:${shiftQuietRange(fascia, "end", -1)}`),
    done(`🌙 alle ${hourLabel(fascia.end)}`),
    button("➕ 1h", `cfg:quiet:${shiftQuietRange(fascia, "end", 1)}`),
  ]);
  righe.push(
    QUIET_CHOICES.map((value) =>
      button(
        prefs.quietHours === value || (value === "off" && prefs.quietHours === "")
          ? `• ${labelQuiet(value)}`
          : labelQuiet(value),
        `cfg:quiet:${value}`,
      ),
    ),
  );

  // 📬 Orari del digest: un interruttore per ora, da mezzanotte a mezzanotte.
  const ore = DIGEST_HOURS.map((hour) =>
    button(prefs.digestHours.includes(hour) ? `• ${hourShort(hour)}` : hourShort(hour), `cfg:hour:${hour}`),
  );
  for (let index = 0; index < ore.length; index += ORE_PER_RIGA) {
    righe.push(ore.slice(index, index + ORE_PER_RIGA));
  }
  const digestValue = prefs.digestHours.length === 0 ? "off" : prefs.digestHours.join(",");
  righe.push(
    DIGEST_CHOICES.map((value) =>
      button(digestValue === value ? `• ${labelDigest(value)}` : labelDigest(value), `cfg:digest:${value}`),
    ),
  );

  righe.push([
    prefs.active ? button("⏸ Sospendi notifiche", "cfg:notify:off") : button("▶️ Riattiva notifiche", "cfg:notify:on"),
  ]);
  righe.push([button("🎛 Cosa vedi", "s:filtri")]);
  righe.push([button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")]);
  return { inline_keyboard: righe };
}

/**
 * 📡 Fonti: si legge e si torna, con una porta sola in più — la diagnostica, cioè
 * la domanda successiva ("e questa fonte serve a qualcosa?").
 */
export function fontiKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("🌡 Diagnostica", "s:diagnostica")],
      ...navRows(),
    ],
  };
}

/**
 * 🌡 Diagnostica delle fonti: da qui si passa alle fonti (per vedere l'ultimo
 * tentativo) o direttamente a spegnerne una SOLO PER TE (🎛 Scegli le fonti),
 * che è la cosa che si può fare senza toccare il codice.
 */
export function diagnosticaKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("📡 Fonti", "s:fonti"), button("🎛 Scegli le fonti", "s:filtri-fonti")],
      [button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")],
    ],
  };
}

/**
 * Il vantaggio di tempistica non ha scelte da fare: si legge e si torna. L'unica
 * scorciatoia utile è la schermata delle fonti, da cui si vede perché un anticipo
 * può essere storto (una fonte ferma da giorni non porta niente a nessuno).
 */
export function vantaggioKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("📡 Fonti", "s:fonti"), button("🔄 Aggiorna", "refresh")],
      [button("🏠 Menù", "home")],
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
 *
 * `marche` fa lo stesso per la sezione dei preferiti: quando è vuota perché non
 * segui ancora nessuna marca, il posto dove rimediare è la schermata delle marche.
 */
export function emptyKeyboard(conFiltri: boolean, marche = false): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  if (marche) rows.push([button("🏷 Preferiti per marca", "s:preferiti")]);
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
    case "coupon":
      return "Coupon e rimborsi";
    case "fonti":
      return "Fonti e raccolte";
    case "vantaggio":
      return "Vantaggio di tempistica";
    case "impostazioni":
      return "Impostazioni";
    case "filtri":
      return "Cosa vedi";
    case "filtri-fonti":
      return "Scegli le fonti";
    case "preferiti":
      return "Preferiti per marca";
    case "diagnostica":
      return "Diagnostica delle fonti";
    case "preferiti-lista":
      return "Le marche che segui";
    case "cerca":
      return "Cerca";
    default:
      return "Concorsi Radar";
  }
}
