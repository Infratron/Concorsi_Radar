import type { ItemRow } from "../types.ts";
import { truncate } from "../lib/text.ts";
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

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Ora locale italiana (0-23), robusta anche con ICU che restituisce "24". */
export function localHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: ROME,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  if (!Number.isFinite(hour)) return 0;
  return hour === 24 ? 0 : hour;
}

/**
 * Ora locale italiana "12:03": è l'ora che il report della raccolta mette accanto
 * a ogni fonte ("ha risposto alle 12:03"). Niente giorno: il report è di adesso.
 */
export function localTimeShort(now: Date): string {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: ROME,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/**
 * L'ora locale italiana come istante UTC: la differenza con l'istante vero è lo
 * scostamento del fuso in vigore in quel momento.
 */
function localWallClockMs(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ROME,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
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
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ROME,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
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
  // "cashback" li dice già la sezione (e il 💶 della riga).
  const tags = item.tags.filter(
    (tag) => tag !== "aggregatore" && tag !== "sitemap" && tag !== "news" && tag !== "coupon" && tag !== "cashback",
  );
  if (tags.length === 0) return "";
  return `🏷 ${escapeHtml(tags.slice(0, max).join(", "))}`;
}

/** Riga compatta per liste lunghe (digest, /oggi, /settimana). */
export function formatItemLine(item: ItemRow, now: Date): string {
  const left = daysLeft(item.deadline, now);
  const urgency = left !== null && left >= 0 && left <= 7 ? ` ⏳${left}gg` : "";
  const title = truncate(item.title, 90);
  // 💶 al posto del punteggio: un buono sconto non si giudica con "quanto vale la
  // pena guardare questo concorso" (premio, sforzo, scadenza).
  const testa = item.kind === "coupon" ? "💶" : `⭐${item.score}`;
  return `${testa}${urgency} · <a href="${escapeHtml(item.url)}">${escapeHtml(title)}</a>`;
}

/** Scheda completa di un concorso, usata dagli avvisi istantanei e dalle schede. */
export function formatItemCard(item: ItemRow, now: Date): string {
  const lines: string[] = [];
  const articolo = item.kind === "news";
  const offerta = item.kind === "coupon";
  lines.push(
    offerta
      ? `💶 <b>Coupon o rimborso</b>${deadlineLabel(item, now)}${purchaseLabel(item)}`
      : `${articolo ? "📰" : "🎁"} <b>${item.score}</b>/100${deadlineLabel(item, now)}${purchaseLabel(item)}`,
  );
  lines.push(`<b><a href="${escapeHtml(item.url)}">${escapeHtml(truncate(item.title, 160))}</a></b>`);
  // Chi apre la scheda deve sapere che cosa ha davanti: la pagina del concorso, un
  // pezzo che ne parla, o un'offerta da spendere. È la differenza che l'utente ha
  // chiesto di rendere evidente.
  if (articolo) lines.push("📰 Articolo sul concorso: il link non è la pagina ufficiale.");
  if (offerta) lines.push("💶 Buono sconto o rimborso: qui non si vince niente, si spende meno.");
  if (item.prize) lines.push(`🏆 Premio: ${escapeHtml(truncate(item.prize, 160))}`);
  if (item.participation) lines.push(`📝 Come partecipare: ${escapeHtml(truncate(item.participation, 160))}`);
  const tags = tagLabel(item);
  if (tags) lines.push(tags);
  const summary = item.summary.trim();
  if (summary.length > 0 && !item.prize) lines.push(escapeHtml(truncate(summary, 220)));
  lines.push(`🔎 Fonte: ${escapeHtml(sourceLabel(item.sourceId))}`);
  return lines.join("\n");
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

  const pezzi = voci.map((voce) => {
    const massimo = voce.max === null || voce.max === 0 ? "" : `/${voce.max}`;
    return `${voce.label} <b>${segno(voce.points)}${voce.points === 0 ? "0" : Math.abs(voce.points)}</b>${massimo}`;
  });
  // Due voci per riga: su un telefono ognuna sta su una riga sola e l'occhio
  // scorre la colonna dei numeri invece di andare a capo a caso.
  for (let indice = 0; indice < pezzi.length; indice += 2) {
    righe.push(pezzi.slice(indice, indice + 2).join(" · "));
  }

  if (opzioni.salvato !== spiegazione.total) {
    righe.push(
      `💾 Alla raccolta <b>${opzioni.salvato}</b> · con i gusti di adesso <b>${spiegazione.total}</b> ` +
        "(il filtro usa il primo)",
    );
  }

  if (opzioni.soglia > 0) {
    const scarto = opzioni.soglia - opzioni.salvato;
    righe.push(
      scarto > 0
        ? `⭐ Soglia <b>${opzioni.soglia}</b>: mancano <b>${scarto}</b> ${scarto === 1 ? "punto" : "punti"} per passarla`
        : scarto < 0
          ? `⭐ Soglia <b>${opzioni.soglia}</b>: la passa di <b>${-scarto}</b> ${scarto === -1 ? "punto" : "punti"}`
          : `⭐ Soglia <b>${opzioni.soglia}</b>: esattamente al limite`,
    );
  } else {
    righe.push("⭐ Nessuna soglia accesa: le stelle in fondo agli elenchi non stanno tagliando niente.");
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
