import type { ItemRow, Prefs, RefundRow } from "../types.ts";
import { refundAmountFor, refundAmountLabel, refundDeclaredLabel, refundMenuLabel } from "../refunds.ts";
import { brandLabel, type BrandChoice } from "../config/brands.ts";
import { truncate } from "../lib/text.ts";
import {
  ARCHIVIO_KINDS,
  CATEGORY_LABELS,
  PRIZE_QUICK_FILTERS,
  STAR_CHOICES,
  TAG_FILTERS,
  categoriesToOffer,
  prizeFilterFor,
  starLabel,
  type FilterSource,
} from "../filters.ts";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./api.ts";
import { formatDate, itemDetailLine, sourceLabel } from "./format.ts";
import { dutiesFor } from "../enrich/proof.ts";
import type { HelpPage } from "./help.ts";
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
 * Etichetta di un concorso in un elenco: DUE righe, come il digest.
 *
 * Prima riga: punteggio e titolo. Seconda: premio sintetico e scadenza. Il
 * bottone di Telegram accetta il ritorno a capo, quindi la schermata può dire
 * le stesse due cose della riga di digest senza rubare spazio al titolo — e non
 * serve aprire la scheda per capire cosa si vince o quando chiude.
 *
 * Il titolo è troncato perché Telegram tronca da sé, e vogliamo decidere noi
 * dove: 40 caratteri stanno in una riga di bottone senza andare a capo di
 * nuovo, che farebbe una terza riga (e una tastiera alta il doppio).
 */
export function itemButtonLabel(item: ItemRow, now: Date): string {
  // 📰 per un articolo e 💶 per un coupon, al posto di ⭐: in un elenco (e nella
  // ricerca, dove i tre tipi convivono) si vede subito che quello non è la pagina
  // su cui si partecipa.
  //
  // Il coupon non porta il punteggio: il punteggio risponde a "quanto vale la
  // pena guardare questo concorso adesso" (premio, sforzo, scadenza) e su un
  // buono sconto non vuol dire niente — mostrarlo sarebbe un numero inventato.
  const segno = item.kind === "news" ? "📰" : item.kind === "coupon" ? "💶" : "⭐";
  const testa = item.kind === "coupon" ? segno : `${segno}${item.score}`;
  const prima = `${testa} · ${truncate(item.title, 46)}`;
  const dettaglio = truncate(itemDetailLine(item, now), 46);
  return dettaglio.length > 0 ? `${prima}\n${dettaglio}` : prima;
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
  /** Rimborsi richiesti e non ancora ricevuti: è il numero sul bottone 💰. */
  rimborsi: number;
  /** Denaro in attesa, in centesimi: l'etichetta del bottone lo dice a colpo d'occhio. */
  rimborsiCents: number;
  /** true se qualche attesa è un tetto: l'etichetta dice "fino a". */
  rimborsiCap: boolean;
  /**
   * Quante marche segui. È il numero sul bottone, e conta le MARCHE, non i loro
   * concorsi: la voce si chiama "Marche seguite" e un conteggio di concorsi lì
   * sopra la farebbe sembrare un elenco ("seguo quattro marche, non quattro
   * concorsi").
   */
  seguite: number;
  /** Quanti filtri sono attivi: 0 = si vede tutto. */
  filtri: number;
}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(`🆕 Nuovi (${counts.nuovi})`, "s:nuovi"), button(`📋 Oggi (${counts.oggi})`, "s:oggi")],
      [button(`📅 7 giorni (${counts.settimana})`, "s:settimana"), button(`⏳ Scadenze (${counts.scadenze})`, "s:scadenze")],
      // "Che premio cerchi?" è una domanda secca, e la porta che la pone è una
      // sola: 🎁 Tipi di premio, che ha dentro anche 🆓 Gratis. Prima il menù
      // aveva tutte e due le voci e la stessa cosa si apriva da due posti, con
      // due conteggi da tenere allineati.
      [button("🎁 Tipi di premio", "s:premi")],
      [button(`⭐ Watchlist (${counts.salvati})`, "s:salvati"), button(`📰 News (${counts.news})`, "s:news")],
      [button("🔍 Cerca", "s:cerca"), button("🗂 Storico", "s:storico")],
      // Le offerte su una riga tutta loro: non sono concorsi e non stanno in
      // mezzo ai concorsi, ma devono restare a un tocco dal menù.
      [button(`💶 Coupon e rimborsi (${counts.coupon})`, "s:coupon")],
      // 💰 Rimborsi sta sotto i coupon perché è il seguito naturale: prima trovi
      // l'offerta, poi la richiedi e la segui qui. Il numero sono le richieste
      // ancora in attesa, e quando c'è denaro da riavere l'importo è sul bottone:
      // "quanto mi deve ancora tornare?" è la domanda per cui esiste la sezione.
      [button(refundMenuLabel(counts.rimborsi, counts.rimborsiCents, counts.rimborsiCap), "s:rimborsi")],
      [button(`🏷 Marche seguite (${counts.seguite})`, "s:preferiti"), button(filtriButtonLabel(counts.filtri), "s:filtri")],
      [button("📡 Fonti", "s:fonti"), button("⚙️ Impostazioni", "s:impostazioni")],
      // ❓ Aiuto sta accanto ad Aggiorna perché è l'altra cosa che si fa quando
      // non si capisce: rileggere o chiedere come funziona.
      [button("🔄 Aggiorna", "refresh"), button("❓ Aiuto", "s:aiuto")],
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

/**
 * La tastiera della wiki: una pagina alla volta, con le frecce.
 *
 * `page:` è lo stesso callback delle pagine degli elenchi — cambia il numero di
 * pagina della sezione aperta, e nella sezione ❓ quel numero è l'indice della
 * pagina di aiuto. Un callback in più sarebbe una strada in più da tenere
 * allineata per fare la stessa cosa.
 */
export function helpKeyboard(pages: HelpPage[], active: number | null): InlineKeyboardMarkup {
  const righe: InlineKeyboardButton[][] = [];
  if (active === null) {
    // L'indice: un bottone per argomento, due per riga. È una mappa, non un
    // percorso — con le frecce si poteva solo scorrere, e chi cercava
    // "Impostazioni" doveva toccare quindici volte e ricordarsi dov'era.
    const bottoni = pages.map((pagina) => button(pagina.title, `s:aiuto:${pagina.id}`));
    for (let index = 0; index < bottoni.length; index += 2) righe.push(bottoni.slice(index, index + 2));
    righe.push([button("🏠 Menù", "home")]);
    return { inline_keyboard: righe };
  }
  const pagina = pages[active];
  // Dalla pagina si va DIRETTAMENTE alla sezione che spiega: è la cosa che si
  // vuole fare dopo aver letto "come funziona".
  if (pagina?.section) righe.push([button(`➡️ ${pagina.title}`, `s:${pagina.section}`)]);
  righe.push([button("❓ Tutti gli argomenti", "s:aiuto"), button("🏠 Menù", "home")]);
  return { inline_keyboard: righe };
}

/**
 * Il bottone contestuale "❓ Aiuto" di una sezione, quando la wiki la spiega.
 * Sta in fondo all'elenco (non nella riga di navigazione) perché è una cosa che
 * si cerca, non una cosa che si fa a ogni schermata.
 */
export function helpRow(page: HelpPage | null): InlineKeyboardButton[][] {
  return page === null ? [] : [[button("❓ Aiuto", `s:aiuto:${page.id}`)]];
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
  righe.push([button(`🏷 Marche seguite (${filtro.favoriteBrands.length})`, "s:preferiti")]);
  // Le marche spente si riaccendono da qui: una marca spenta non compare in
  // nessun elenco, quindi senza questa porta non ci sarebbe modo di tornarci.
  righe.push([
    filtro.mutedBrands.length === 0
      ? done("🔕 Marche spente (0)")
      : button(`🔕 Marche spente (${filtro.mutedBrands.length})`, "s:filtri-marche"),
  ]);
  righe.push([button(`📡 Scegli le fonti (${info.sources - info.spenti}/${info.sources})`, "s:filtri-fonti")]);
  return { inline_keyboard: [...righe, ...navRows()] };
}

/**
 * 🏷 Marche seguite: l'elenco delle marche da seguire. Ogni bottone è un
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
  righe.push([button("⬅️ Indietro", "back"), button("🎛 Cosa vedi", "s:filtri"), button("🏠 Menù", "home")]);
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
  if (pagina.total > 1) rows.push(pagesRow(pagina.index, pagina.total, { prec: "⬅️ Prec", succ: "Succ ➡️" }));
  rows.push([button("♻️ Vedi di nuovo tutto", "cfg:reset:all")]);
  rows.push([button("⬅️ Indietro", "back"), button("🎛 Cosa vedi", "s:filtri"), button("🏠 Menù", "home")]);
  return { inline_keyboard: rows };
}

/**
 * 🔕 Marche spente: l'unico posto da cui si riaccendono. Un bottone per marca
 * (sono poche, si spengono una alla volta guardando una scheda), più il ritorno
 * a 🎛 Cosa vedi.
 */
export function filtriMarcheKeyboard(muted: string[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = muted.map((id) => [
    button(`🔔 ${brandLabel(id)}`, `um:${id}`),
  ]);
  rows.push([button("🎛 Cosa vedi", "s:filtri"), button("🏠 Menù", "home")]);
  return { inline_keyboard: rows };
}

/**
 * La coda standard di ogni schermata: indietro, aggiorna, menù.
 *
 * `back` non è un salto al menù: torna alla schermata da cui si è arrivati, con
 * la sua pagina, e dentro una scheda la chiude e basta (vedi applyIntent). Prima
 * l'unico modo per uscire da una schermata annidata era ripartire dal menù, e
 * per tornare a una pagina 5 di 6 bisognava rifare le frecce.
 */
export function navRow(): InlineKeyboardButton[] {
  return [button("⬅️ Indietro", "back"), button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")];
}

function navRows(): InlineKeyboardButton[][] {
  return [navRow()];
}

/**
 * La riga delle pagine: inizio, precedente, contatore, successiva.
 *
 * ⏮ c'è sempre, anche quando non serve: un bottone che sparisce sposta tutti gli
 * altri, e da una pagina 5 di 6 tornare all'inizio con le frecce è il motivo per
 * cui questa riga esiste.
 */
function pagesRow(
  index: number,
  total: number,
  labels: { prec: string; succ: string },
): InlineKeyboardButton[] {
  return [
    index > 0 ? button("⏮ Inizio", "page:0") : done("⏮ Inizio"),
    index > 0 ? button(labels.prec, `page:${index - 1}`) : done(labels.prec),
    done(`${index + 1}/${total}`),
    index < total - 1 ? button(labels.succ, `page:${index + 1}`) : done(labels.succ),
  ];
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
  /**
   * Tutto quello che il bot ha visto: è il numero sulla porta 📚 Archivio. Non
   * è la somma dei tre sopra — quelli sono le TUE decisioni, questo è la memoria
   * del radar, che comprende anche quello che non ti è mai stato consegnato.
   */
  archivio: number;
}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(`🏆 Vinti (${counts.vinti})`, "s:vinti"), button(`⌛ Scaduti (${counts.scaduti})`, "s:scaduti")],
      [button(`🚫 Ignorati (${counts.ignorati})`, "s:ignorati"), button(`📚 Archivio (${counts.archivio})`, "s:archivio")],
      // Il riepilogo sta qui e non nel menù: è la sintesi di queste tre cose,
      // quindi si legge dal posto dove si guardano le proprie decisioni.
      [button("📊 I tuoi numeri", "s:numeri")],
      navRow(),
    ],
  };
}

/**
 * 📊 I tuoi numeri: leggere e basta. Le due scorciatoie sono le sezioni da cui
 * si possono ancora cambiare le cose (storico e rimborsi).
 */
export function numeriKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("🗂 Storico", "s:storico"), button("💰 Rimborsi", "s:rimborsi")],
      navRow(),
    ],
  };
}

/**
 * 📚 Archivio: quattro modi di guardare la stessa memoria — tutto, oppure solo
 * concorsi, coupon, articoli — più la porta alla ricerca, che adesso guarda anche
 * qui dentro.
 *
 * I numeri sono quelli dell'archivio INTERO (ogni stato, ogni fonte): questa
 * schermata non conosce i filtri della chat, quindi un numero diverso da quello
 * delle altre sezioni non è un errore — è la differenza fra "cosa esiste" e
 * "cosa vedi".
 */
export function archivioKeyboard(
  items: ItemRow[],
  now: Date,
  pagina: { index: number; total: number },
  info: {
    /** Sezione attiva: "archivio", oppure "archivio:coupon" per una sola fetta. */
    sezione: string;
    totale: number;
    concorsi: number;
    coupon: number;
    articoli: number;
  },
): InlineKeyboardMarkup {
  // Prima le voci che si aprono, poi come si restringe l'elenco: la schermata
  // serve a leggere l'archivio, i bottoni delle fette sono il modo di cambiare
  // domanda — se stessero in cima, ogni pagina comincerebbe con sei bottoni di
  // navigazione invece che con quello che sei venuto a cercare.
  const rows: InlineKeyboardButton[][] = items.map((item) => [
    button(itemButtonLabel(item, now), `open:${item.id}`),
  ]);
  if (pagina.total > 1) rows.push(pagesRow(pagina.index, pagina.total, { prec: "⬅️ Prec", succ: "Succ ➡️" }));
  const voce = (sezione: string, testo: string): InlineKeyboardButton =>
    button(sezione === info.sezione ? `• ${testo}` : testo, `s:${sezione}`);
  rows.push([voce("archivio", `📚 Tutto (${info.totale})`), voce("archivio:contest", `🎁 Concorsi (${info.concorsi})`)]);
  rows.push([voce("archivio:coupon", `💶 Coupon (${info.coupon})`), voce("archivio:news", `📰 Articoli (${info.articoli})`)]);
  rows.push([button("🔍 Cerca in tutto", "s:cerca")]);
  rows.push(navRow());
  return { inline_keyboard: rows };
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
  /**
   * Righe in più prima della navigazione: le viste di una sezione (per ora solo
   * 💶 Coupon, che ha gli stessi tagli dei concorsi). Restano DENTRO l'elenco, non
   * in una schermata a parte: cambiare vista è un tocco, e i concorsi che stai
   * guardando non spariscono per andare a scegliere il filtro.
   */
  extraRows: InlineKeyboardButton[][] = [],
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = items.map((item) => [
    button(itemButtonLabel(item, now), `open:${item.id}`),
  ]);

  if (pagina.total > 1) rows.push(pagesRow(pagina.index, pagina.total, { prec: "⬅️ Prec", succ: "Succ ➡️" }));
  for (const riga of extraRows) rows.push(riga);
  if (stelleMinime !== null) rows.push(starKeyboard(stelleMinime));
  rows.push(navRow());
  return { inline_keyboard: rows };
}

/**
 * 💰 I miei rimborsi: una riga per richiesta, con lo stato in testa e la cifra
 * accanto al titolo. Il tocco apre la scheda dell'offerta, dove stanno ✅
 * L'ho ricevuto e ↩️ Annulla: qui si legge quanto manca, lì si cambia.
 */
export function rimborsiKeyboard(
  refunds: RefundRow[],
  pagina: { index: number; total: number },
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = refunds.map((refund) => [
    button(
      `${refund.receivedAt === null ? "⏳" : "✅"} ${refundAmountLabel(refund)} · ${truncate(refund.item.title, 38)}`,
      `open:${refund.itemId}`,
    ),
  ]);
  if (pagina.total > 1) rows.push(pagesRow(pagina.index, pagina.total, { prec: "⬅️ Prec", succ: "Succ ➡️" }));
  rows.push(navRow());
  return { inline_keyboard: rows };
}

/**
 * La frase che accompagna il link condiviso, per tipo di riga.
 *
 * Non è il titolo dell'item e non parla del bot: chi riceve il messaggio deve
 * capire in due parole che gli stanno mandando un concorso, non trovare il testo
 * di una scheda pensata per chi il bot ce l'ha già.
 */
export function sharePhrase(kind: string): string {
  if (kind === "coupon") return "Hey! Dai un'occhiata a questa offerta!";
  if (kind === "news") return "Hey! Dai un'occhiata a questo articolo!";
  return "Hey! Dai un'occhiata a questo concorso!";
}

/**
 * Dove vive la pagina di condivisione se chi chiama non lo dice.
 *
 * È la produzione: serve ai test e a un chiamante distratto, non alla chat — lì
 * l'origine arriva dalla richiesta (`shareBase` in BotDeps), così un dominio
 * custom non richiede di toccare questo file.
 */
export const SHARE_BASE_DEFAULT = "https://concorsi-radar.mg-infradev.workers.dev";

/**
 * Link al pannello di condivisione del telefono.
 *
 * Perché non `t.me/share/url`: quel bottone apre solo le chat di Telegram, e
 * "condividi" per chi lo tocca vuol dire WhatsApp, messaggi, mail. I bot non
 * hanno un "condividi" nativo, quindi il bottone porta a una nostra pagina
 * (`/share`, src/share.ts) che chiama `navigator.share()` e, dove non c'è, offre
 * WhatsApp/Telegram/Email/Copia.
 *
 * Nel messaggio ci sono SOLO la frase e l'URL dell'item (la pagina del concorso,
 * o quella che lo menziona): niente titolo, niente punteggio, niente nome del
 * bot — quello che si manda deve reggersi da solo.
 */
export function shareUrlFor(item: Pick<ItemRow, "url" | "kind">, base = SHARE_BASE_DEFAULT): string {
  const testo = sharePhrase(item.kind);
  const origine = base.replace(/\/+$/, "");
  return `${origine}/share?u=${encodeURIComponent(item.url)}&t=${encodeURIComponent(testo)}`;
}

/** Il giorno dopo, da una data ISO `YYYY-MM-DD`: serve a chiudere un evento di un
 * giorno solo (Google Calendar vuole inizio e fine, e la fine è il giorno dopo). */
function giornoDopo(iso: string): string {
  const [anno, mese, giorno] = iso.split("-").map(Number);
  return new Date(Date.UTC(anno, mese - 1, giorno + 1)).toISOString().slice(0, 10);
}

/**
 * 📅 Promemoria: la data che conta, già dentro il calendario del telefono.
 *
 * Nessuna integrazione e nessun token: è il link pubblico di Google Calendar con
 * l'evento compilato (`action=TEMPLATE`). Il giorno è quello che si perde più
 * facilmente — la scadenza del concorso, o la data entro cui chiedere il premio
 * quando il bando la dichiara — e su un coupon la validità del buono.
 *
 * Null quando non c'è una data, su un articolo (non c'è niente da fare) e sui
 * rimborsi senza data: un evento inventato sarebbe peggio di nessun bottone.
 */
export function calendarUrlFor(item: ItemRow, now: Date): { label: string; url: string } | null {
  if (item.kind === "news") return null;
  const doveri = dutiesFor(item, now);
  const richiesta = doveri.claim?.kind === "date" ? doveri.claim.date : null;
  const giorno = (richiesta ?? item.deadline ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(giorno)) return null;

  const titolo = richiesta ? `Richiedi il premio: ${item.title}` : `Scade: ${item.title}`;
  const dettagli = [
    richiesta ? `Premio da richiedere entro il ${formatDate(giorno)}: non arriva da solo.` : "",
    item.prize ? `Premio: ${item.prize}` : "",
    item.url,
    `Fonte: ${sourceLabel(item.sourceId)}`,
  ]
    .filter((riga) => riga.length > 0)
    .join("\n");
  const query = new URLSearchParams({
    action: "TEMPLATE",
    text: truncate(titolo, 90),
    dates: `${giorno.replace(/-/g, "")}/${giornoDopo(giorno).replace(/-/g, "")}`,
    details: truncate(dettagli, 500),
  });
  return {
    label: richiesta ? "📅 Richiedi il premio" : item.kind === "coupon" ? "📅 Scadenza coupon" : "📅 Scadenza",
    url: `https://calendar.google.com/calendar/render?${query.toString()}`,
  };
}

/**
 * Scheda di un concorso: le tre decisioni, i link, la condivisione e il ritorno
 * all'elenco da cui si è arrivati. 🚫 e 🏆, una volta scelti, restano visibili
 * ma inerti; ⭐ invece si toglie (☆ Togli dalla watchlist), perché una watchlist
 * da cui non si esce non è una lista, è una condanna.
 */
export function cardKeyboard(
  item: ItemRow,
  decision: string | null,
  regolamentoUrl: string | null,
  /** Origine della pagina /share (vedi shareUrlFor). */
  shareBase = SHARE_BASE_DEFAULT,
  /** La richiesta di rimborso di QUESTA chat, se c'è (solo coupon). */
  refund: RefundRow | null = null,
  /**
   * L'istante della schermata, per il promemoria in calendario. Null (o assente)
   * = nessun bottone 📅: chi costruisce la tastiera per un test non deve
   * inventarsi una data.
   */
  now: Date | null = null,
  /**
   * true = la marca di questo item è già spenta in questa chat. Non si legge da
   * `prefs` qui dentro perché la tastiera è una funzione pura dell'item: chi la
   * costruisce sa cosa ha scelto l'utente, e glielo dice.
   */
  brandMuted = false,
): InlineKeyboardMarkup {
  // Su un coupon 🏆 Vinto non vuol dire niente: un buono sconto non si vince, si
  // spende. Restano le due decisioni che hanno senso (tenerlo d'occhio, scartarlo)
  // e al loro posto arriva il bottone del rimborso.
  // ⭐ è un interruttore, non un timbro: da salito deve poter scendere. Un
  // "già fatto" inerte lasciava il concorso in watchlist per sempre, senza un
  // posto da cui toglierlo — la watchlist stessa lo mostra, ma aprirlo non
  // offriva niente. L'etichetta dice l'azione (togliere), non lo stato: lo stato
  // è già nella riga "⭐ Nella tua watchlist" sopra la scheda.
  const decisioni: InlineKeyboardButton[] = [
    decision === "saved"
      ? button("☆ Togli dalla watchlist", `unsave:${item.id}`)
      : button("⭐ Watchlist", `save:${item.id}`),
    decision === "ignored" ? done("🚫 Ignorato") : button("🚫 Non mi interessa", `ign:${item.id}`),
  ];
  if (item.kind !== "coupon") {
    decisioni.push(
      decision === "won" ? done("🏆 Vinto") : button("🏆 Vinto", `won:${item.id}`),
    );
  }
  const dichiarato = item.kind === "coupon" ? refundAmountFor(item) : null;
  const rimborso: InlineKeyboardButton[] =
    dichiarato === null
      ? []
      : refund === null
        ? [
            // Con una cifra dichiarata si registra subito; senza (percentuale,
            // 1+1) la chat deve chiedere quanto è tornato indietro davvero.
            dichiarato.cents === null
              ? button("💰 Ho richiesto · quanto?", `rf:ask:${item.id}`)
              : button(`💰 Ho richiesto · ${refundDeclaredLabel(dichiarato)}`, `rf:claim:${item.id}`),
          ]
        : refund.receivedAt === null
          ? [
              button(`✅ L'ho ricevuto · ${refundAmountLabel(refund)}`, `rf:recv:${item.id}`),
              button("↩️ Annulla", `rf:undo:${item.id}`),
            ]
          : [
              button(`✅ Ricevuto · ${refundAmountLabel(refund)}`, "noop"),
              button("↩️ Annulla", `rf:undo:${item.id}`),
            ];

  // 🔗 Apri e 📤 Condividi sulla stessa riga: sono le due cose che si fanno con
  // quel link. 📄 Regolamento resta a parte quando c'è, che sono tre bottoni
  // lunghi e su un telefono stretto si mangerebbero la riga.
  const link: InlineKeyboardButton[] = [
    { text: "🔗 Apri", url: item.url },
    { text: "📤 Condividi", url: shareUrlFor(item, shareBase) },
  ];
  const righe: InlineKeyboardButton[][] = [decisioni];
  if (rimborso.length > 0) righe.push(rimborso);
  // 🔕 Mai più questa marca: la granularità che mancava fra "questo concorso"
  // e "questa fonte". È un interruttore e si vede: da spenta il bottone riaccende
  // (utile sulle schede della ⭐ Watchlist, che i filtri non li applicano).
  if (typeof item.brand === "string" && item.brand.length > 0) {
    const marca = truncate(brandLabel(item.brand), 26);
    righe.push([
      brandMuted
        ? button(`🔔 Rivedi ${marca}`, `um:${item.brand}`)
        : button(`🔕 Mai più ${marca}`, `mb:${item.brand}`),
    ]);
  }
  righe.push(link);
  // 📄 e 📅 insieme: sono le due cose che si fanno con una data in mano —
  // leggerla e metterla in agenda.
  const promemoria = now === null ? null : calendarUrlFor(item, now);
  const info: InlineKeyboardButton[] = [];
  if (regolamentoUrl) info.push({ text: "📄 Regolamento", url: regolamentoUrl });
  if (promemoria) info.push({ text: promemoria.label, url: promemoria.url });
  if (info.length > 0) righe.push(info);
  righe.push([button("⬅️ Torna all'elenco", "back"), button("🔄 Aggiorna", "refresh"), button("🏠 Menù", "home")]);
  return { inline_keyboard: righe };
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
  righe.push(navRow());
  return { inline_keyboard: righe };
}

/**
 * 📡 Fonti: si legge e si torna, con una porta in più — la diagnostica, cioè la
 * domanda successiva ("e questa fonte serve a qualcosa?").
 *
 * 🧾 Log c'è solo per l'admin: è il racconto fonte per fonte di ogni raccolta, la
 * roba da cui si capisce *perché* una fonte non porta niente. Non è un segreto,
 * è che l'altra persona in chat non ha niente da farne: se le comparisse, ogni
 * domanda su un guasto finirebbe lì. Il gate è doppio — il bottone non esiste
 * nella sua tastiera e la sezione non si apre nemmeno da un callback vecchio (vedi
 * bot.ts).
 */
export function fontiKeyboard(isAdmin: boolean): InlineKeyboardMarkup {
  const righe: InlineKeyboardButton[][] = [];
  if (isAdmin) righe.push([button("🧾 Log delle raccolte", "s:log")]);
  righe.push([button("🌡 Diagnostica", "s:diagnostica")]);
  return { inline_keyboard: [...righe, ...navRows()] };
}

/**
 * 🧾 Log delle raccolte: una raccolta per schermata, con il suo racconto intero.
 *
 * Il passo è la raccolta, non la pagina di un elenco: qui `page` è quale log si
 * sta leggendo (0 = il più recente), e le frecce portano avanti e indietro nella
 * storia. Il conteggio in mezzo è l'unica cosa che dice quanto indietro si è
 * arrivati.
 */
export function logKeyboard(pagina: { index: number; total: number }): InlineKeyboardMarkup {
  const righe: InlineKeyboardButton[][] = [];
  if (pagina.total > 1) {
    righe.push(pagesRow(pagina.index, pagina.total, { prec: "⬅️ Più recente", succ: "Più vecchio ➡️" }));
  }
  righe.push([button("⬅️ Indietro", "back"), button("📡 Fonti", "s:fonti"), button("🏠 Menù", "home")]);
  righe.push([button("🔄 Aggiorna", "refresh")]);
  return { inline_keyboard: righe };
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
      navRow(),
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
      [button("⬅️ Indietro", "back"), button("🏠 Menù", "home")],
    ],
  };
}

/** Schermate senza scelte: solo il ritorno (fonti, prompt della ricerca, errori). */
export function backKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [navRow()] };
}

/**
 * Elenco vuoto. Se la chat ha dei filtri attivi la strada per tornare indietro
 * deve stare lì: "non c'è niente" e "hai spento tu le fonti" sono due cose
 * diverse, e senza questo bottone la seconda sembra la prima.
 *
 * `marche` fa lo stesso per la sezione dei preferiti: quando è vuota perché non
 * segui ancora nessuna marca, il posto dove rimediare è la schermata delle marche.
 */
export function emptyKeyboard(
  conFiltri: boolean,
  marche = false,
  extraRows: InlineKeyboardButton[][] = [],
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  if (marche) rows.push([button("🏷 Marche seguite", "s:preferiti")]);
  // Anche con l'elenco vuoto le viste restano a portata: "oggi non c'è niente"
  // non deve essere un vicolo cieco se gli ultimi 7 giorni sono pieni.
  for (const riga of extraRows) rows.push(riga);
  if (conFiltri) rows.push([button("🎛 Cosa vedi", "s:filtri")]);
  return { inline_keyboard: [...rows, ...navRows()] };
}

/**
 * 💶 Le viste dei coupon: gli stessi tagli delle sezioni dei concorsi — oggi,
 * ultimi 7 giorni, in scadenza — più la fetta dei rimborsi, che è quella con
 * dentro gli "spendi e riprendi" (soldi indietro su una spesa, non un buono da
 * ritagliare).
 *
 * Perché sotto l'elenco e non in una schermata a parte: la sezione dei coupon
 * non ha i conteggi del menù, quindi una porta in più non direbbe niente che
 * l'elenco non dica già. Qui invece si cambia taglio restando sulle offerte, e
 * la vista attiva è marcata con • come nelle impostazioni.
 */
export function couponViewsRows(active: string): InlineKeyboardButton[][] {
  const vista = (label: string, section: string): InlineKeyboardButton =>
    button(active === section ? `• ${label}` : label, `s:${section}`);
  return [
    [vista("🗂 Tutti", "coupon"), vista("📋 Oggi", "coupon-oggi")],
    [vista("📅 7 giorni", "coupon-settimana"), vista("⏳ In scadenza", "coupon-scadenze")],
    [vista("↩️ Rimborsi e cashback", "coupon-rimborsi")],
  ];
}

/** Testo leggibile della sezione, per l'intestazione delle schermate. */
/**
 * 🎁 Tipi di premio: le porte per tipo di premio, con quanti concorsi
 * aprirebbero ADESSO. Il numero nasce dalla stessa query della sezione (stessa
 * regola dei conteggi del menù): se il bottone dicesse 35 e l'elenco ne mostrasse
 * 12, il primo dei due mentirebbe.
 */
export function premiKeyboard(counts: Record<string, number>): InlineKeyboardMarkup {
  const bottoni = PRIZE_QUICK_FILTERS.map((voce) =>
    button(`${voce.emoji} ${voce.label} (${counts[voce.section] ?? 0})`, `s:${voce.section}`),
  );
  const righe: InlineKeyboardButton[][] = [];
  for (let index = 0; index < bottoni.length; index += 2) righe.push(bottoni.slice(index, index + 2));
  return { inline_keyboard: [...righe, ...navRows()] };
}

/** Testo leggibile della sezione, per l'intestazione delle schermate. */
export function sectionTitle(section: string): string {
  if (section.startsWith("cerca:")) return `Ricerca: ${section.slice("cerca:".length)}`;
  // Le sezioni per tipo di premio si intitolano come il loro bottone. 🆓 Gratis
  // non passa di qua: ha un titolo suo ("Solo gratis (senza acquisto)"), più
  // esplicito di un'emoji.
  if (section.startsWith("premi:")) {
    const premio = prizeFilterFor(section);
    if (premio) return `${premio.emoji} ${premio.label}`;
  }
  // 📚 Archivio: il titolo dice anche la fetta, altrimenti "Archivio · 46 item"
  // non si capisce se sono tutti o solo i coupon.
  if (section === "archivio" || section.startsWith("archivio:")) {
    const tipo = ARCHIVIO_KINDS.find((voce) => voce.section === section);
    return tipo ? `📚 Archivio · ${tipo.label}` : "📚 Archivio";
  }
  switch (section) {
    case "premi":
      return "Tipi di premio";
    case "nuovi":
      return "Nuovi dall'ultimo controllo";
    case "oggi":
      // Il titolo dice il confine: a mezzanotte questa sezione riparte da zero, e
      // il giorno prima si guarda in 📅 7 giorni.
      return "Oggi (dalle 00:00)";
    case "aiuto":
      return "Aiuto";
    case "settimana":
      return "Ultimi 7 giorni";
    case "scadenze":
      return "In scadenza";
    case "salvati":
      return "Watchlist";
    case "storico":
      return "Storico";
    case "numeri":
      return "I tuoi numeri";
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
    // Le viste dei coupon hanno un titolo che dice il taglio: senza, in cima a
    // un elenco di buoni sconto, "Oggi" e "In scadenza" sarebbero la stessa
    // parola con due significati diversi.
    case "coupon-oggi":
      return "Coupon di oggi";
    case "coupon-settimana":
      return "Coupon degli ultimi 7 giorni";
    case "coupon-scadenze":
      return "Coupon in scadenza";
    case "coupon-rimborsi":
      return "Rimborsi e cashback";
    case "rimborsi":
      return "I miei rimborsi";
    case "gratis":
      return "Solo gratis (senza acquisto)";
    case "spesa":
      return "Solo con acquisto (spesa richiesta)";
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
    case "filtri-marche":
      return "Marche spente";
    case "preferiti":
      return "Marche seguite";
    case "diagnostica":
      return "Diagnostica delle fonti";
    case "log":
      return "Log delle raccolte";
    case "preferiti-lista":
      return "Le marche che segui";
    case "cerca":
      return "Cerca";
    default:
      return "Concorsi Radar";
  }
}
