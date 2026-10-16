/**
 * Helper condivisi dai parser di ingestione (RSS/Atom, sitemap, liste HTML).
 * Nessuna dipendenza: il piano Free di Workers concede 10 ms di CPU per
 * invocazione, quindi niente parser XML completo, solo regex mirate.
 */

import { decodeEntities, stripHtml } from "../lib/text.ts";

/** Srotola i blocchi CDATA, frequenti nei feed degli aggregatori. */
export function unwrapCdata(input: string): string {
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/**
 * Testo leggibile: via CDATA, tag ed entità, spazi compressi.
 * Doppio `stripHtml` perché alcuni feed (Atom `type="html"`) codificano i tag
 * come entità: il primo giro le decodifica, il secondo rimuove i tag emersi.
 */
export function cleanText(input: string): string {
  return stripHtml(stripHtml(unwrapCdata(input))).replace(/\s+/g, " ").trim();
}

/** Tutti i blocchi `<tag>…</tag>` in ordine di comparsa, contenuto incluso. */
export function collectBlocks(xml: string, tags: string[]): string[] {
  const blocks: string[] = [];
  for (const tag of tags) {
    const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
      blocks.push(match[1]);
    }
  }
  return blocks;
}

/** Primo tag valorizzato fra quelli indicati, come testo pulito. */
export function textOf(block: string, tags: string[]): string | null {
  for (const tag of tags) {
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
    if (match) {
      const value = cleanText(match[1]);
      if (value.length > 0) return value;
    }
  }
  return null;
}

/** Valore di un attributo dentro la stringa di attributi di un tag. */
export function attrValue(tagAttributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tagAttributes);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? "").trim();
}

/** URL assoluto http(s), oppure null se relativo non risolvibile o non navigabile. */
export function resolveUrl(raw: string | null, baseUrl: string): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (/^(mailto:|tel:|javascript:|data:|#)/i.test(value)) return null;
  try {
    const url = new URL(value, baseUrl.length > 0 ? baseUrl : undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Filtro su URL: pattern vuoto o non compilabile = nessun filtro. */
export function matchesPattern(url: string, pattern: string | null): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, "i").test(url);
  } catch {
    return true;
  }
}

/** Data in ISO 8601 UTC; accetta RFC 822 (feed RSS) e ISO (Atom, lastmod). */
export function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
