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
