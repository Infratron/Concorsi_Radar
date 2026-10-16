import type { RawItem } from "../types.ts";
import { truncate } from "../lib/text.ts";
import { attrValue, collectBlocks, resolveUrl, textOf, toIsoDate } from "./shared.ts";

const MAX_SUMMARY = 400;
const ENTRY_TAGS = ["item", "entry"];
const TITLE_TAGS = ["title"];
const SUMMARY_TAGS = ["description", "summary", "content:encoded", "content"];
const DATE_TAGS = ["pubDate", "published", "updated", "dc:date", "date"];
const ID_TAGS = ["guid", "id"];

interface BuildOptions {
  /** Google News: titoli in stile "Titolo - Testata", da ripulire. */
  newsStyle?: boolean;
  /** Testata esatta (dal tag <source>) da togliere dal titolo. */
  stripSuffix?: string | null;
}

/**
 * Il taglio del suffisso si applica solo ai titoli in stile news: sui feed
 * normali un trattino è spesso parte del titolo e non va toccato.
 */
function stripTitleSuffix(title: string, suffix: string | null | undefined, newsStyle: boolean): string {
  if (suffix && suffix.length > 1) {
    const tail = ` - ${suffix}`;
    if (title.toLowerCase().endsWith(tail.toLowerCase())) {
      return title.slice(0, -tail.length).trim() || title;
    }
  }
  if (!newsStyle) return title;
  // Fallback: la coda dopo il trattino deve somigliare a una testata.
  const stripped = title.replace(/\s+[-–|]\s+[^-–|]{2,48}$/, "").trim();
  return stripped.length > 0 ? stripped : title;
}

function linkOf(block: string, baseUrl: string): string | null {
  // Atom: <link rel="alternate" href="…"/> — il primo href vince.
  const atomLink = /<link\b([^>]*)\/?>/i.exec(block);
  if (atomLink) {
    const href = attrValue(atomLink[1], "href");
    const resolvedHref = resolveUrl(href, baseUrl);
    if (resolvedHref) return resolvedHref;
  }
  const textLink = textOf(block, ["link"]);
  const resolvedText = resolveUrl(textLink, baseUrl);
  if (resolvedText) return resolvedText;
  // RSS 1.0 usa rdf:about sull'item; alcuni feed mettono l'URL nel guid.
  const about = attrValue(block.slice(0, 400), "rdf:about");
  const resolvedAbout = resolveUrl(about, baseUrl);
  if (resolvedAbout) return resolvedAbout;
  return resolveUrl(textOf(block, ID_TAGS), baseUrl);
}

function buildItem(
  block: string,
  sourceId: string,
  baseUrl: string,
  options: BuildOptions = {},
): RawItem | null {
  const rawTitle = textOf(block, TITLE_TAGS);
  const url = linkOf(block, baseUrl);
  if (!rawTitle || !url) return null;

  const summary = textOf(block, SUMMARY_TAGS);
  const guid = textOf(block, ID_TAGS);

  return {
    sourceId,
    url,
    title: truncate(stripTitleSuffix(rawTitle, options.stripSuffix, options.newsStyle === true), 200),
    summary: summary ? truncate(summary, MAX_SUMMARY) : "",
    publishedAt: toIsoDate(textOf(block, DATE_TAGS)),
    guid: guid ?? null,
  };
}

/**
 * Parser unico per RSS 2.0, RSS 1.0/RDF e Atom: la forma dei blocchi è la
 * stessa, cambiano solo i nomi dei tag, gestiti dalle liste sopra.
 */
export function parseRssFeed(
  xml: string,
  sourceId: string,
  baseUrl: string,
  maxItems: number,
): RawItem[] {
  const items: RawItem[] = [];
  for (const block of collectBlocks(xml, ENTRY_TAGS)) {
    if (items.length >= maxItems) break;
    const item = buildItem(block, sourceId, baseUrl);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Google News: i titoli arrivano come "Titolo articolo - Testata" e il tag
 * `<source>` contiene la testata, quindi il suffisso si toglie in modo esatto.
 */
export function parseGoogleNewsFeed(
  xml: string,
  sourceId: string,
  maxItems: number,
): RawItem[] {
  const items: RawItem[] = [];
  for (const block of collectBlocks(xml, ENTRY_TAGS)) {
    if (items.length >= maxItems) break;
    const sourceName = textOf(block, ["source"]);
    const item = buildItem(block, sourceId, "https://news.google.com/", {
      newsStyle: true,
      stripSuffix: sourceName,
    });
    if (item) items.push(item);
  }
  return items;
}
