import type { FetchLike, IngestContext, RawItem, SourceRow, SourceRunResult } from "../types.ts";
import type { Store } from "../db/store.ts";
import { fetchText } from "../lib/http.ts";
import { isPathAllowed, originOf, parseRobots } from "../lib/robots.ts";
import { parseGoogleNewsFeed, parseRssFeed } from "./rss.ts";
import { parseSitemap } from "./sitemap.ts";
import { parseHtmlLinks } from "./httplist.ts";

export interface IngestDeps {
  store: Store;
  fetcher: FetchLike;
  userAgent: string;
  robotsTtlHours?: number;
}

const DEFAULT_ROBOTS_TTL_HOURS = 24;
/**
 * Tetto di item per fonte quando la config non lo dice: 20 item costano ~5 ms
 * di CPU (misurato con npm run bench:cpu e con la rotta /bench in workerd),
 * quindi una fonte sola non sfonda il budget di 6 ms del piano Free.
 */
const DEFAULT_MAX_ITEMS = 20;
const SITEMAP_MAX_CHILDREN = 3;

/**
 * robots.txt si controlla solo per html e sitemap: i feed RSS/Atom e Google
 * News sono endpoint di sindacazione pubblicati apposta per il consumo
 * automatico, e applicare robots lì bloccherebbe proprio le fonti più fresche.
 * Decisione documentata nel README.
 */
function needsRobotsCheck(source: SourceRow): boolean {
  return source.kind === "html" || source.kind === "sitemap";
}

async function robotsDenied(
  source: SourceRow,
  deps: IngestDeps,
  ctx: IngestContext,
  now: Date,
): Promise<boolean> {
  const origin = originOf(source.url);
  if (!origin) return false;

  const ttlMs = (deps.robotsTtlHours ?? DEFAULT_ROBOTS_TTL_HOURS) * 3_600_000;
  let body: string | null = null;

  const cached = await deps.store.getRobots(origin);
  if (cached && Number.isFinite(Date.parse(cached.fetchedAt)) && now.getTime() - Date.parse(cached.fetchedAt) < ttlMs) {
    body = cached.body;
  } else {
    // robots.txt assente, 404 o errore = permesso (fail-open).
    const response = await fetchText(`${origin}/robots.txt`, ctx, { accept: "text/plain", maxRetries: 0 });
    body = response.ok ? response.body : "";
    await deps.store.saveRobots(origin, body, now.toISOString());
  }

  if (!body || body.trim().length === 0) return false;

  let path = "/";
  try {
    const parsed = new URL(source.url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return false;
  }
  return !isPathAllowed(parseRobots(body, deps.userAgent), path);
}

/** Su un <sitemapindex> segue al più 3 figlie, preferendo quelle sui concorsi. */
async function parseSitemapDeep(
  source: SourceRow,
  deps: IngestDeps,
  ctx: IngestContext,
  rootXml: string,
  maxItems: number,
): Promise<RawItem[]> {
  const pattern = source.includePattern ?? null;
  const root = parseSitemap(rootXml, source.id, pattern, maxItems);
  if (root.childSitemaps.length === 0 || root.items.length >= maxItems) return root.items;

  const items = [...root.items];
  const seen = new Set(items.map((item) => item.url));
  const children = [...new Set(root.childSitemaps)]
    .sort((a, b) => Number(/concors/i.test(b)) - Number(/concors/i.test(a)))
    .slice(0, SITEMAP_MAX_CHILDREN);

  for (const child of children) {
    if (items.length >= maxItems) break;
    const response = await fetchText(child, ctx, { maxRetries: 0 });
    if (!response.ok) continue;
    const parsed = parseSitemap(response.body, source.id, pattern, maxItems - items.length);
    for (const item of parsed.items) {
      if (items.length >= maxItems) break;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
    }
  }
  return items;
}

/**
 * Scarica una fonte e restituisce gli item grezzi. NON scrive sul database:
 * la persistenza, la deduplica e il conteggio dei fallimenti sono della pipeline.
 */
export async function ingestSource(
  source: SourceRow,
  deps: IngestDeps,
  now: Date,
): Promise<SourceRunResult> {
  const base: SourceRunResult = {
    sourceId: source.id,
    httpStatus: null,
    notModified: false,
    robotsDenied: false,
    items: [],
    etag: source.etag ?? null,
    lastModified: source.lastModified ?? null,
    error: null,
    parseMs: 0,
  };

  const ctx: IngestContext = { fetcher: deps.fetcher, userAgent: deps.userAgent, now };

  if (needsRobotsCheck(source) && (await robotsDenied(source, deps, ctx, now))) {
    return { ...base, robotsDenied: true };
  }

  const response = await fetchText(source.url, ctx, {
    conditional: { etag: source.etag, lastModified: source.lastModified },
  });

  if (response.notModified) {
    return {
      ...base,
      httpStatus: response.status,
      notModified: true,
      etag: response.etag,
      lastModified: response.lastModified,
    };
  }

  if (!response.ok) {
    return {
      ...base,
      httpStatus: response.status,
      etag: response.etag,
      lastModified: response.lastModified,
      error: response.error ?? `HTTP ${response.status}`,
    };
  }

  const maxItems = source.maxItems ?? DEFAULT_MAX_ITEMS;
  // Il parsing è la parte CPU di questa funzione: la cronometriamo per il freno
  // di budget della pipeline (le attese di rete non contano sul piano Free).
  const parseStarted = performance.now();
  try {
    let items: RawItem[];
    switch (source.kind) {
      case "news":
        items = parseGoogleNewsFeed(response.body, source.id, maxItems);
        break;
      case "sitemap":
        items = await parseSitemapDeep(source, deps, ctx, response.body, maxItems);
        break;
      case "html":
        items = parseHtmlLinks(response.body, source.id, source.url, source.includePattern ?? null, maxItems);
        break;
      default:
        items = parseRssFeed(response.body, source.id, source.url, maxItems);
    }

    return {
      ...base,
      httpStatus: response.status,
      items,
      etag: response.etag,
      lastModified: response.lastModified,
      parseMs: Math.round((performance.now() - parseStarted) * 100) / 100,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      ...base,
      httpStatus: response.status,
      etag: response.etag,
      lastModified: response.lastModified,
      error: `parse: ${message}`,
      parseMs: Math.round((performance.now() - parseStarted) * 100) / 100,
    };
  }
}
