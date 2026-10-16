import type { RawItem } from "../types.ts";
import { collectBlocks, matchesPattern, resolveUrl, textOf, toIsoDate } from "./shared.ts";

/** Segmenti troppo generici per diventare un titolo utili. */
const WEAK_SEGMENTS = new Set([
  "blog", "news", "concorsi", "concorsi-a-premi", "promozioni", "promo", "it", "index",
  "archivio", "category", "categoria", "page", "pagina", "amici",
]);

/**
 * Titolo leggibile da un URL di sitemap: prende l'ultimo segmento
 * significativo dello slug e lo rende in Title Case.
 * "…/concorsi-a-premi/concorso-esselunga-buoni-spesa-2026/" → "Concorso Esselunga Buoni Spesa 2026".
 */
export function titleFromUrl(url: string): string {
  let pathname = "";
  let host = "";
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    host = parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }

  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment
        // Estensione e doppioni WordPress ("-2"): non fanno parte del titolo.
        .replace(/\.(html?|php|aspx?|xml)$/i, "")
        .replace(/-(\d{1,2})$/, ""),
    );

  let candidate = "";
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (/^\d+$/.test(segment)) continue;
    if (WEAK_SEGMENTS.has(segment.toLowerCase())) continue;
    if (segment.replace(/[^a-z0-9]/gi, "").length < 4) continue;
    candidate = segment;
    break;
  }
  if (candidate.length === 0) return host;

  return candidate
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface ParsedSitemap {
  items: RawItem[];
  /** URL delle sitemap figlie, solo per un documento <sitemapindex>. */
  childSitemaps: string[];
}

/**
 * Legge sia un <urlset> sia un <sitemapindex>.
 * includePattern filtra i <loc>: nel caso di un indice NON si applica alle
 * sitemap figlie (i loro URL non contengono i path degli articoli), ma alle
 * entry contenute in ciascuna figlia.
 */
export function parseSitemap(
  xml: string,
  sourceId: string,
  includePattern: string | null,
  maxItems: number,
): ParsedSitemap {
  const items: RawItem[] = [];
  const childSitemaps: string[] = [];

  for (const block of collectBlocks(xml, ["sitemap"])) {
    const loc = resolveUrl(textOf(block, ["loc"]), "");
    if (loc) childSitemaps.push(loc);
  }

  for (const block of collectBlocks(xml, ["url"])) {
    if (items.length >= maxItems) break;
    const url = resolveUrl(textOf(block, ["loc"]), "");
    if (!url) continue;
    if (!matchesPattern(url, includePattern)) continue;
    items.push({
      sourceId,
      url,
      title: titleFromUrl(url),
      summary: "",
      publishedAt: toIsoDate(textOf(block, ["lastmod"])),
      guid: url,
    });
  }

  return { items, childSitemaps };
}
