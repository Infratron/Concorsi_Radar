import type { ItemRow } from "../types.ts";
import { truncate } from "../lib/text.ts";
import { dutiesFor } from "../enrich/proof.ts";
import { playTimeFor } from "../enrich/playtime.ts";
import { formatEuro, spendRefundFor } from "../refunds.ts";
import { SOURCES } from "../config/sources.ts";
import { MAX_MESSAGE_CHARS } from "./api.ts";

/** Nome leggibile della fonte: in chat "Scontrino Felice", non "scontrinofelice-gratuiti". */
export function sourceLabel(sourceId: string): string {
  return SOURCES.find((source) => source.id === sourceId)?.name ?? sourceId;
}

/**
 * Formattazione dei messaggi (HTML: è meno fragile di MarkdownV2 sui contenuti
 * che arrivano dai feed). Ogni valore proveniente da una fonte passa da
 * escapeHtml: i titoli contengono spesso <, > e &.
 */

export interface DigestSection {
  title: string;
  items: ItemRow[];
}

const ROME = "Europe/Rome";

/**
 * I formattatori si costruiscono UNA volta per isolate, non a ogni chiamata.
 *
 * `new Intl.DateTimeFormat` è la parte cara: su Workers la CPU si conta in
 * millisecondi e queste funzioni girano per ogni riga di un elenco (e due volte
 * per ogni avviso). Il formattatore è immutabile e indipendente dall'istante,
 * quindi riusarlo non cambia nessun risultato: cambia solo quanto costa.
 */
const HOUR_FORMAT = new Intl.DateTimeFormat("it-IT", {
  timeZone: ROME,
  hour: "numeric",
  hour12: false,
});
const TIME_SHORT_FORMAT = new Intl.DateTimeFormat("it-IT", {
  timeZone: ROME,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const WALL_CLOCK_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: ROME,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: ROME,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const DAY_MONTH_TIME_FORMAT = new Intl.DateTimeFormat("it-IT", {
  timeZone: ROME,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Ora locale italiana (0-23), robusta anche con ICU che restituisce "24". */
export function localHour(now: Date): number {
  const parts = HOUR_FORMAT.formatToParts(now);
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  if (!Number.isFinite(hour)) return 0;
  return hour === 24 ? 0 : hour;
}

/**
 * Ora locale italiana "12:03": è l'ora che il report della raccolta mette accanto
 * a ogni fonte ("ha risposto alle 12:03"). Niente giorno: il report è di adesso.
 */
export function localTimeShort(now: Date): string {
  const parts = TIME_SHORT_FORMAT.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/**
 * Un istante come "17/10 14:05" in ora italiana: giorno, ora e minuti.
 *
 * Sta qui e non in screens.ts perché creava un formattatore a ogni riga
 * disegnata: è la stessa schermata, ma il costo si paga a ogni tocco.
 */
export function localDayMonthTime(at: Date): string {
  const parts = DAY_MONTH_TIME_FORMAT.formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

/**
 * L'ora locale italiana come istante UTC: la differenza con l'istante vero è lo
 * scostamento del fuso in vigore in quel momento.
 */
function localWallClockMs(now: Date): number {
  const parts = WALL_CLOCK_FORMAT.formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  // Alcune implementazioni di ICU scrivono "24" per la mezzanotte: la stessa
  // difesa di localHour, altrimenti il giorno comincerebbe un giorno dopo.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return Date.parse(`${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}.000Z`);
}

/**
 * Quando è cominciato il giorno italiano (mezzanotte a Roma), in ISO UTC: è il
 * confine di 📋 Oggi.
 *
 * Perché non "adesso meno 24 ore": quella è una finestra che scorre, e alle
 * 01:00 contiene ancora tutto il giorno prima — cioè esattamente quello che non
 * ci si aspetta da una sezione che si chiama "Oggi". Mezzanotte non è l'istante
 * in cui il calendario dice zero: è dove comincia il giorno di chi legge.
 *
 * La notte del cambio d'ora il conto usa lo scostamento in vigore ORA, quindi il
 * confine può spostarsi di un'ora: sui digest la stessa tolleranza è dichiarata,
 * e per un elenco di concorsi è un'imprecisione che non costa niente.
 */
export function startOfLocalDay(now: Date): string {
  const offsetMs = localWallClockMs(now) - now.getTime();
  return new Date(Date.parse(`${localDateString(now)}T00:00:00.000Z`) - offsetMs).toISOString();
}

/** Data locale italiana come YYYY-MM-DD (per confronti con le scadenze). */
export function localDateString(now: Date): string {
  const parts = DATE_FORMAT.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseIsoDate(value: string | null): { y: number; m: number; d: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** gg/mm/aaaa, oppure "—" se la data non è disponibile. */
export function formatDate(iso: string | null): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return "—";
  return `${String(parsed.d).padStart(2, "0")}/${String(parsed.m).padStart(2, "0")}/${parsed.y}`;
}

/** Giorni che mancano alla scadenza (negativi se già passata), null se assente. */
export function daysLeft(deadline: string | null, now: Date): number | null {
  const parsed = parseIsoDate(deadline);
  if (!parsed) return null;
  const today = parseIsoDate(localDateString(now));
  if (!today) return null;
  const deadlineMs = Date.UTC(parsed.y, parsed.m - 1, parsed.d);
  const todayMs = Date.UTC(today.y, today.m - 1, today.d);
  return Math.round((deadlineMs - todayMs) / 86_400_000);
}

function deadlineLabel(item: ItemRow, now: Date): string {
  const left = daysLeft(item.deadline, now);
  if (left === null) return "";
  if (left < 0) return " · ⛔ scaduto";
  if (left === 0) return ` · ⏳ scade oggi (${formatDate(item.deadline)})`;
  if (left <= 7) return ` · ⏳ ${left} gg (${formatDate(item.deadline)})`;
  return ` · ⏳ ${formatDate(item.deadline)}`;
}

function purchaseLabel(item: ItemRow): string {
  return item.requiresPurchase ? " · 🛒 serve acquisto" : "";
}

function tagLabel(item: ItemRow, max = 4): string {
  // Via i tag che dicono solo da dove arriva l'item o che cosa è: "coupon" e
  // "cashback" li dice già la sezione (e il 💶 della riga), "acquisto" è già
  // il 🛒 della testa. Un tag che ripete qualcosa di già scritto è rumore.
  const tags = item.tags.filter(
    (tag) =>
      tag !== "aggregatore" && tag !== "sitemap" && tag !== "news" &&
      tag !== "coupon" && tag !== "cashback" && tag !== "acquisto",
  );
  if (tags.length === 0) return "";
  // I tag interni usano l'underscore ("buoni_spesa"): in chat si leggono come
  // nomi di variabili, non come parole. Separatore a punto medio, non virgola:
  // la riga si legge come un elenco di etichette, non come una frase.
  return `🏷 ${escapeHtml(tags.slice(0, max).map((tag) => tag.replace(/_/g, " ")).join(" · "))}`;
}

/**
 * Data breve per gli elenchi: "24/11", con l'anno solo quando è un altro.
 *
 * In un elenco di concorsi l'anno è quasi sempre quello in corso: scriverlo
 * dodici volte occupa la riga che serve al premio. Quando invece la scadenza
 * è l'anno prossimo, l'anno torna, perché "12/01" da solo si legge come
 * passato prossimo.
 */
function shortDate(iso: string, now: Date): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return "";
  const oggi = parseIsoDate(localDateString(now));
  const anno = oggi?.y === parsed.y ? "" : `/${String(parsed.y).slice(2)}`;
  return `${String(parsed.d).padStart(2, "0")}/${String(parsed.m).padStart(2, "0")}${anno}`;
}

/**
 * La scadenza in poche parole: "⏳ 4 giorni (24/11)", "⏳ 24/11", "⏳ scade
 * oggi", "⛔ scaduto il 12/11". Nei primi sette giorni il conto è esplicito
 * perché è quello che cambia la decisione; dopo basta la data.
 */
export function deadlineBrief(item: ItemRow, now: Date): string {
  if (!item.deadline) return "";
  const left = daysLeft(item.deadline, now);
  const data = shortDate(item.deadline, now);
  if (left === null || data.length === 0) return "";
  if (left < 0) return `⛔ scaduto il ${data}`;
  if (left === 0) return `⏳ scade oggi (${data})`;
  if (left <= 7) return `⏳ ${left} ${left === 1 ? "giorno" : "giorni"} (${data})`;
  return `⏳ ${data}`;
}

/**
 * Il premio in poche parole, per gli elenchi.
 *
 * Un coupon non ha un premio: ha una cifra che torna indietro, e quella è la
 * cosa da leggere. Una news non ha né premio né offerta, e dirlo è meglio che
 * lasciare la seconda riga vuota.
 */
export function prizeBrief(item: ItemRow): string {
  if (item.kind === "coupon") {
    const soldi = spendRefundFor(item);
    const cents = soldi.refund.cents;
    if (cents !== null) {
      const importo = `${soldi.refund.cap ? "fino a " : ""}${formatEuro(cents)}`;
      // Con la soglia dichiarata il numero utile è il rapporto: "20 € su
      // 100 €" dice più di "20 € indietro", perché mette le due cifre vicine.
      if (soldi.spendCents !== null) {
        const pct = Math.round((cents / soldi.spendCents) * 100);
        return `💶 ${importo} su ${formatEuro(soldi.spendCents)} · ${pct}%`;
      }
      return `💶 ${importo} indietro`;
    }
    if (soldi.spendCents !== null) return `💶 spesa minima ${formatEuro(soldi.spendCents)}`;
    return "💶 buono sconto";
  }
  if (item.kind === "news") return "📰 articolo";
  if (item.prize) return `🏆 ${truncate(item.prize, 70)}`;
  // Il premio c'è ma il testo non lo dice: "nel bando" è l'unica cosa vera
  // che si può scrivere, e tiene la seconda riga al suo posto.
  return "🏆 premio nel bando";
}

/** La seconda riga di un elenco: premio sintetico e scadenza, uniti. */
export function itemDetailLine(item: ItemRow, now: Date): string {
  return [prizeBrief(item), deadlineBrief(item, now)].filter((parte) => parte.length > 0).join(" · ");
}

/**
 * Riga di un elenco (digest, anteprime): DUE righe, non una.
 *
 * Prima riga: punteggio e titolo, che è quello su cui si decide se aprire.
 * Seconda: premio e scadenza, che è quello che si vuole sapere senza aprire.
 * Su una riga sola le due cose si contendevano lo spazio e la scadenza vinceva
 * solo negli ultimi sette giorni; qui il premio c'è sempre, e la data pure —
 * breve quando è lontana, con il conto dei giorni quando stringe.
 */
export function formatItemLine(item: ItemRow, now: Date): string {
  const title = truncate(item.title, 90);
  // 💶 al posto del punteggio: un buono sconto non si giudica con "quanto vale la
  // pena guardare questo concorso" (premio, sforzo, scadenza).
  const testa = item.kind === "coupon" ? "💶" : `⭐${item.score}`;
  const prima = `${testa} · <a href="${escapeHtml(item.url)}">${escapeHtml(title)}</a>`;
  return `${prima}\n${escapeHtml(itemDetailLine(item, now))}`;
}

/**
 * Una riga "campo" della scheda: etichetta in grassetto, valore dopo un punto
 * medio. La forma è sempre la stessa, così l'occhio scorre le etichette in
 * verticale invece di leggere ogni riga da capo — è la richiesta "più leggibile"
 * nella sua parte concreta: prima erano etichette in chiaro con i due punti in
 * mezzo al testo, indistinguibili dal valore.
 */
function campo(emoji: string, label: string, value: string): string {
  return `${emoji} <b>${label}</b> · ${value}`;
}

/**
 * Scheda completa di un concorso, usata dagli avvisi istantanei e dalle schede.
 *
 * Struttura a blocchi separati da una riga vuota, non un elenco unico: in cima
 * che cosa è e il titolo, poi i fatti (premio, partecipazione), poi gli obblighi
 * (cosa conservare, entro quando chiedere), infine descrizione, tag e fonte. Un
 * blocco per cosa, quindi, è quello che rende leggibile una pagina con dieci
 * informazioni: la riga vuota è il confine che mancava.
 */
export function formatItemCard(item: ItemRow, now: Date): string {
  const articolo = item.kind === "news";
  const offerta = item.kind === "coupon";
  const blocks: string[] = [];

  // Testa + titolo: cosa è (punteggio per i concorsi, che è l'unica cosa che il
  // numero misura, tipo per gli altri due), quando chiude, e il link da toccare.
  const testa = offerta
    ? `💶 <b>Coupon</b>${deadlineLabel(item, now)}${purchaseLabel(item)}`
    : articolo
      ? `📰 <b>Articolo</b>${deadlineLabel(item, now)}`
      : `🎁 <b>${item.score}</b>/100${deadlineLabel(item, now)}${purchaseLabel(item)}`;
  blocks.push(`${testa}\n<b><a href="${escapeHtml(item.url)}">${escapeHtml(truncate(item.title, 160))}</a></b>`);

  // I fatti: che cosa si prende e come si partecipa. Su un coupon il premio non
  // si vince, quindi l'etichetta è "Offerta": chiamarlo premio sarebbe l'errore
  // che la scheda deve evitare.
  const fatti: string[] = [];
  if (item.prize) fatti.push(campo(offerta ? "💶" : "🏆", offerta ? "Offerta" : "Premio", escapeHtml(truncate(item.prize, 160))));
  if (item.participation) fatti.push(campo("📝", "Come partecipare", escapeHtml(truncate(item.participation, 160))));
  // 💰 Il rimborso con la sua soglia: "20 € su una spesa di 100 € · 20%" è
  // l'unica forma in cui si capisce se conviene. Quando la spesa non è
  // dichiarata resta la cifra da sola, senza un rapporto inventato.
  if (offerta) {
    const soldi = spendRefundFor(item);
    if (soldi.refund.cents !== null || soldi.spendCents !== null) {
      const parti: string[] = [];
      if (soldi.refund.cents !== null) {
        parti.push(`${soldi.refund.cap ? "fino a " : ""}${formatEuro(soldi.refund.cents)}`);
        if (soldi.spendCents !== null) {
          const pct = Math.round((soldi.refund.cents / soldi.spendCents) * 100);
          parti.push(`su una spesa di ${formatEuro(soldi.spendCents)} · ${pct}%${soldi.refund.cap ? " max" : ""}`);
        }
        fatti.push(campo("💰", "Rimborso", parti.join(" ")));
      } else if (soldi.spendCents !== null) {
        fatti.push(campo("🧾", "Spesa minima", formatEuro(soldi.spendCents)));
      }
    }
  }
  // 🎁 Premio certo: il bando dice anche QUANDO si gioca. La riga c'è solo se
  // il testo dichiara un orario o una cadenza — una finestra inventata sarebbe
  // peggio di una riga mancante — e lo stato (dentro/fuori) si calcola adesso,
  // al momento in cui la scheda si apre.
  if (!articolo && item.tags.includes("premio_certo")) {
    const quando = playTimeFor(item, now);
    const parti: string[] = [];
    if (quando.window) parti.push(`<b>${quando.window.label}</b>`);
    if (quando.days) parti.push(escapeHtml(quando.days));
    if (quando.every) parti.push(escapeHtml(quando.every));
    if (quando.status === "inside") parti.push("✅ adesso si gioca");
    if (quando.status === "outside" && quando.reason === "time") {
      parti.push(`🚫 adesso fuori orario${quando.opensAt ? ` (${escapeHtml(quando.opensAt)})` : ""}`);
    }
    // Fuori per il giorno: la restrizione è già scritta sopra ("solo il
    // sabato"), quindi qui basta dire che oggi non è quel giorno.
    if (quando.status === "outside" && quando.reason === "day") parti.push("🚫 oggi no");
    if (parti.length > 0) fatti.push(campo("🕐", "Quando giocare", parti.join(" · ")));
  }
  // Chi apre la scheda deve sapere che cosa ha davanti: la pagina del concorso, un
  // pezzo che ne parla, o un'offerta da spendere. È la differenza che l'utente ha
  // chiesto di rendere evidente; sta qui, sotto il titolo, non in fondo.
  if (articolo) fatti.push("ℹ️ Il link porta a un articolo: non è la pagina ufficiale del concorso.");
  if (offerta) fatti.push("ℹ️ Non è un concorso: qui non si vince niente, si spende meno.");
  if (fatti.length > 0) blocks.push(fatti.join("\n"));

  // Gli obblighi: le due cose che si perdono senza accorgersene — la prova da
  // conservare e la finestra per chiedere il premio. Restano sulla scheda anche
  // senza watchlist, così non dipendono da un promemoria mai acceso.
  if (!articolo) {
    const doveri: string[] = [];
    const info = dutiesFor(item, now);
    if (info.keep) doveri.push(campo("🧾", "Da conservare", escapeHtml(info.keep)));
    // Concorso, non coupon: un rimborso si richiede con una scadenza sua, ma
    // chiamarlo "premio" sarebbe un'altra cosa. Gli articoli sono già fuori.
    if (item.kind !== "coupon") {
      if (info.claim?.kind === "date") {
        const mancanti = daysLeft(info.claim.date, now);
        const conto = mancanti !== null && mancanti >= 0 ? ` · ${mancanti} gg` : "";
        doveri.push(`🎫 <b>Premio da richiedere</b> entro il <b>${formatDate(info.claim.date)}</b>${conto}`);
      } else if (info.claim?.kind === "days") {
        const da = info.claim.from ? ` ${escapeHtml(info.claim.from)}` : "";
        doveri.push(`🎫 <b>Premio da richiedere</b> entro <b>${info.claim.days} giorni</b>${da}`);
      } else if (item.tags.includes("premio_da_richiedere") || item.tags.includes("raccolta_punti")) {
        // Il testo non dice quando, e una data inventata sarebbe peggio di
        // nessuna data: si dice l'unica cosa certa, che non arriva da solo.
        doveri.push("🎫 <b>Premio da richiedere</b> · la data è nel bando");
      }
    }
    if (doveri.length > 0) blocks.push(doveri.join("\n"));
  }

  // La descrizione in corsivo: è l'unica parte scritta dalla fonte, non una
  // scheda compilata da noi, e distinguerla evita di leggerla come un dato.
  const summary = item.summary.trim();
  if (summary.length > 0 && !item.prize) blocks.push(`<i>${escapeHtml(truncate(summary, 220))}</i>`);
  const tags = tagLabel(item);
  if (tags) blocks.push(tags);
  // La fonte chiude sempre: è la riga che risponde a "da dove è arrivato" senza
  // rubare spazio ai fatti.
  blocks.push(campo("📡", "Fonte", escapeHtml(sourceLabel(item.sourceId))));
  return blocks.join("\n\n");
}

/** Il segno davanti a una voce del punteggio: +, −, o niente. */
function segno(punti: number): string {
  if (punti > 0) return "+";
  // Il meno tipografico, non il trattino: in una fila di numeri si legge meglio.
  if (punti < 0) return "−";
  return "";
}

/**
 * La scheda del punteggio: le voci che l'hanno prodotto, e la distanza dalla
 * soglia delle stelle.
 *
 * Perché esiste. In chat il voto è un numero secco (`🎁 72/100`) e la riga delle
 * stelle in fondo agli elenchi (`⭐ 70+`, `⭐ 80+`) è un filtro che taglia senza
 * spiegarsi: chi vede un concorso sparire non ha modo di sapere se ha perso per
 * il premio, per la scadenza o perché ha toccato 🚫 su quel tipo. Qui le voci si
 * vedono una per una, coi punti che ognuna ha aggiunto e il massimo che poteva
 * aggiungere — comprese le voci a zero, che sono quelle che spiegano un voto
 * basso ("premio 0/30" dice più di "72").
 *
 * Due numeri, quando servono. Il filtro confronta il punteggio SALVATO alla
 * raccolta; le voci qui sotto sommano quello di ADESSO, con i gusti e le marche
 * che hai in questo momento. Se i due divergono si dicono tutti e due, invece di
 * mostrarne uno e far finta che sia l'altro.
 */
export function formatScoreBreakdown(
  spiegazione: { parts: Array<{ key: string; label: string; points: number; max: number | null }>; total: number },
  opzioni: { soglia: number; salvato: number },
): string {
  const righe: string[] = [`📊 <b>Come nasce il ${opzioni.salvato}</b>`];

  // Le voci che ci sono sempre: sono il corpo del punteggio, e vederle a zero è
  // metà dell'informazione. Le altre compaiono solo quando hanno fatto qualcosa,
  // perché "parole chiave +5" su chi non le ha sarebbe rumore.
  const sempre = new Set(["premio", "sforzo", "scadenza", "freschezza", "senzaAcquisto", "limite"]);
  const voci = spiegazione.parts.filter((voce) => sempre.has(voce.key) || voce.points !== 0);

  // Una voce per riga, col pallino: due colonne di numeri vanno a capo in modo
  // imprevedibile su un telefono, e quando succede le due voci si mescolano. Una
  // riga per voce si legge come una lista, che è quello che è.
  for (const voce of voci) {
    const massimo = voce.max === null || voce.max === 0 ? "" : `/${voce.max}`;
    righe.push(`• ${voce.label} <b>${segno(voce.points)}${voce.points === 0 ? "0" : Math.abs(voce.points)}</b>${massimo}`);
  }

  // Il resto è un commento alla lista: riga vuota prima, così non si confonde con
  // una voce del punteggio.
  if (opzioni.salvato !== spiegazione.total) {
    righe.push(
      "",
      `💾 Alla raccolta <b>${opzioni.salvato}</b> · con i gusti di adesso <b>${spiegazione.total}</b> ` +
        "(il filtro usa il primo)",
    );
  }

  if (opzioni.soglia > 0) {
    const scarto = opzioni.soglia - opzioni.salvato;
    righe.push(
      "",
      scarto > 0
        ? `⭐ Soglia <b>${opzioni.soglia}</b>: mancano <b>${scarto}</b> ${scarto === 1 ? "punto" : "punti"} per passarla`
        : scarto < 0
          ? `⭐ Soglia <b>${opzioni.soglia}</b>: la passa di <b>${-scarto}</b> ${scarto === -1 ? "punto" : "punti"}`
          : `⭐ Soglia <b>${opzioni.soglia}</b>: esattamente al limite`,
    );
  } else {
    righe.push("", "⭐ Nessuna soglia accesa: le stelle in fondo agli elenchi non stanno tagliando niente.");
  }

  return righe.join("\n");
}

/**
 * Compone il digest impacchettando blocchi interi (mai un item spezzato a metà)
 * fino al limite di caratteri per messaggio. Restituisce un array di messaggi.
 */
export function formatDigest(
  sections: DigestSection[],
  now: Date,
  extraLines: string[] = [],
): string[] {
  const blocks: string[] = [];
  blocks.push(`📡 <b>Concorsi Radar</b> · ${formatDate(localDateString(now))}`);

  for (const section of sections) {
    if (section.items.length === 0) continue;
    blocks.push(`\n<b>${escapeHtml(section.title)}</b>`);
    for (const item of section.items) blocks.push(formatItemLine(item, now));
  }
  for (const line of extraLines) if (line.trim().length > 0) blocks.push(escapeHtml(line));

  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    const safeBlock = block.length > MAX_MESSAGE_CHARS ? block.slice(0, MAX_MESSAGE_CHARS) : block;
    const candidate = current.length === 0 ? safeBlock : `${current}\n${safeBlock}`;
    if (candidate.length <= MAX_MESSAGE_CHARS) {
      current = candidate;
      continue;
    }
    if (current.trim().length > 0) messages.push(current);
    current = safeBlock;
  }
  if (current.trim().length > 0) messages.push(current);
  return messages;
}
