import type { RawItem } from "../types.ts";
import { truncate } from "../lib/text.ts";
import { attrValue, cleanText, matchesPattern, resolveUrl } from "./shared.ts";

const MIN_TITLE_LENGTH = 8;

/**
 * Estrae i link di una pagina di elenco senza feed (kind "html").
 * Niente DOM né querySelector: Workers non ne ha uno, quindi si leggono gli
 * `<a href>` e si filtra con includePattern (regex sugli href assoluti).
 */
export function parseHtmlLinks(
  html: string,
  sourceId: string,
  baseUrl: string,
  includePattern: string | null,
  maxItems: number,
): RawItem[] {
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchor.exec(html)) !== null) {
    if (items.length >= maxItems) break;

    const href = attrValue(match[1], "href");
    const url = resolveUrl(href, baseUrl);
    if (!url) continue; // scarta mailto:, tel:, javascript:, # e href assenti
    if (!matchesPattern(url, includePattern)) continue;
    if (seen.has(url)) continue;

    const title = cleanText(match[2]);
    if (title.length < MIN_TITLE_LENGTH) continue;

    seen.add(url);
    items.push({
      sourceId,
      url,
      title: truncate(title, 200),
      summary: "",
      publishedAt: null,
      guid: url,
    });
  }

  return items;
}
