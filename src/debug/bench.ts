import type { RawItem, SourceRow } from "../types.ts";
import type { FetchLike } from "../types.ts";
import { parseGoogleNewsFeed, parseRssFeed } from "../ingest/rss.ts";
import { parseSitemap } from "../ingest/sitemap.ts";
import { parseHtmlLinks } from "../ingest/httplist.ts";
import { fetchText } from "../lib/http.ts";
import { DEDUPE_CANDIDATE_LIMIT, prepareItem } from "../dedupe.ts";
import { enrichWithRules } from "../enrich/rules.ts";
import { baseScore } from "../enrich/score.ts";
import { createMemoryStore, type MemoryStore } from "../db/memory.ts";
import { isDuplicateTitle } from "../lib/text.ts";
import { CPU_BUDGET_MS, MAX_SOURCES_PER_RUN } from "../config/sources.ts";

/**
 * Misurazione della CPU per invocazione: serve a rispondere con i numeri, non
 * con le impressioni, alla domanda "il piano Free di Workers (10 ms di CPU per
 * invocazione) regge il parsing dei feed?".
 *
 * Tutto ciò che è cronometrato qui è codice puro: nessuna attesa di rete dentro
 * le sezioni misurate, perché il limite riguarda la CPU e non il tempo di
 * parete. Le uniche eccezioni dichiarate sono crypto.subtle (sha256, nativo) e
 * le query del database, che in produzione costano I/O ma il cui lato JS va
 * comunque contato.
 */

export interface StageTiming {
  stage: string;
  ms: number;
  items?: number;
}

export interface SourceBench {
  sourceId: string;
  kind: string;
  bytes: number;
  items: number;
  stages: StageTiming[];
  /** parse + arricchimento + punteggio di tutti gli item di questa fonte. */
  totalMs: number;
  msPerItem: number;
  error: string | null;
}

export interface BenchReport {
  sources: SourceBench[];
  /**
   * Cosa costa un tick nel peggiore dei casi (tutti gli item nuovi), simulando
   * la stessa regola del freno: le fonti si leggono finché il budget regge.
   */
  invocationMs: number;
  sourcesInInvocation: number;
  itemsInInvocation: number;
  /** CPU media per item, arricchimento incluso: è il numero che scala. */
  perItemMs: number;
  /** Costo della fonte più cara fra quelle misurate. */
  worstSourceMs: number;
  /** Quante fonti "peggiori" entrano nel budget prudente (senza il tetto). */
  sourcesFittingBudget: number;
  /** La fonte esclusa dal tetto attuale (la successiva in ordine di costo). */
  extraSourceId: string | null;
  /** Quanto costerebbe un'invocazione con UNA fonte in più: mostra il gradino. */
  withExtraSourceMs: number;
  /** CPU client della deduplica (decisione sui candidati), per item. */
  dedupeClientMs: number;
  /** Lato archivio locale: emula la WHERE di D1, NON è CPU del Worker. */
  dedupeStoreMs: number;
  archiveSize: number;
  verdict: string;
}

/** Mediana: robusta rispetto a un singolo picco del sistema operativo. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function timeMedian(runs: number, fn: () => Promise<unknown> | unknown): Promise<number> {
  await fn(); // warm-up: la prima esecuzione paga la compilazione JIT
  const samples: number[] = [];
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

/** Stesso dispatch di src/ingest/index.ts, senza seguire le sitemap figlie. */
export function parseSourceBody(source: SourceRow, body: string, maxItems: number): RawItem[] {
  switch (source.kind) {
    case "news":
      return parseGoogleNewsFeed(body, source.id, maxItems);
    case "sitemap":
      return parseSitemap(body, source.id, source.includePattern ?? null, maxItems).items;
    case "html":
      return parseHtmlLinks(body, source.id, source.url, source.includePattern ?? null, maxItems);
    default:
      return parseRssFeed(body, source.id, source.url, maxItems);
  }
}

/** Costo CPU di una fonte: parsing, poi preparazione/arricchimento/punteggio di ogni item. */
export async function benchSource(
  source: SourceRow,
  body: string,
  runs = 9,
): Promise<SourceBench> {
  const bytes = body.length;
  const maxItems = source.maxItems ?? 30;
  const stages: StageTiming[] = [];

  let items: RawItem[] = [];
  try {
    const parseMs = await timeMedian(runs, () => {
      items = parseSourceBody(source, body, maxItems);
    });
    stages.push({ stage: "parse", ms: round(parseMs), items: items.length });
  } catch (error) {
    return {
      sourceId: source.id, kind: source.kind, bytes, items: 0, stages,
      totalMs: 0, msPerItem: 0,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }

  const campione = items.slice(0, maxItems);
  if (campione.length === 0) {
    return {
      sourceId: source.id, kind: source.kind, bytes, items: 0, stages,
      totalMs: stages[0]?.ms ?? 0, msPerItem: 0, error: null,
    };
  }

  const prepareMs = await timeMedian(runs, async () => {
    for (const item of campione) await prepareItem(item, source.name);
  });
  const enrichMs = await timeMedian(runs, () => {
    for (const item of campione) {
      const insight = enrichWithRules(item, source, new Date("2026-10-16T12:00:00.000Z"));
      baseScore(insight, item, new Date("2026-10-16T12:00:00.000Z"));
    }
  });

  stages.push({ stage: "prepare (url+urlKey+simhash)", ms: round(prepareMs), items: campione.length });
  stages.push({ stage: "enrich+score", ms: round(enrichMs), items: campione.length });

  const totalMs = round((stages[0]?.ms ?? 0) + prepareMs + enrichMs);
  return {
    sourceId: source.id, kind: source.kind, bytes, items: campione.length, stages,
    totalMs, msPerItem: round(totalMs / campione.length), error: null,
  };
}

export interface DedupeLookupBench {
  /** CPU che il Worker paga davvero: la decisione finale sui candidati. */
  clientMs: number;
  /** Lato archivio locale: emula la WHERE di D1, quindi non è CPU del Worker. */
  storeMs: number;
  /** Quanti candidati sono tornati dalla query (tipicamente il limite di 8). */
  candidates: number;
}

/**
 * Costo per item della deduplica, separato in due voci perché solo UNA è CPU:
 * il filtro dei candidati su D1 lo fa SQL (I/O, non CPU), mentre `isDuplicateTitle`
 * sui candidati restituiti gira in JS dentro l'isolate e va contato sul piano Free.
 */
export async function benchDedupeLookup(archiveSize = 300, probes = 20, runs = 5): Promise<DedupeLookupBench> {
  const store: MemoryStore = createMemoryStore();
  const now = new Date("2026-10-16T12:00:00.000Z");
  for (let index = 0; index < archiveSize; index++) {
    await store.insertItem({
      sourceId: "bench", url: `https://bench.example/concorso-${index}`,
      urlKey: `bench-${index}`, simhash: `${index.toString(16).padStart(8, "0")}deadbeef`,
      title: `Concorso di prova numero ${index} in palio buoni spesa`, summary: "",
      publishedAt: null, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(),
      deadline: null, prize: null, participation: null, prizeValue: 0, effort: 0.5,
      requiresPurchase: false, tags: [], score: 0, clusterId: null, status: "new", aiUsed: false,
    });
  }

  const prepared = await prepareItem(
    { sourceId: "bench", url: "https://bench.example/nuovo", title: "Concorso nuovo in palio una gift card", summary: "", publishedAt: null, guid: null },
    "Bench",
  );
  const since = "2026-08-01T00:00:00.000Z";
  const candidates = await store.findDuplicateCandidates(prepared.urlKey, prepared.simhash, since, DEDUPE_CANDIDATE_LIMIT);

  const storeMs = round(
    await timeMedian(runs, async () => {
      for (let index = 0; index < probes; index++) {
        await store.findDuplicateCandidates(prepared.urlKey, prepared.simhash, since, DEDUPE_CANDIDATE_LIMIT);
      }
    }) / probes,
  );

  const clientMs = round(
    await timeMedian(runs, () => {
      for (let index = 0; index < probes; index++) {
        for (const candidate of candidates) {
          if (candidate.urlKey === prepared.urlKey) break;
          isDuplicateTitle(candidate.title, prepared.title);
        }
      }
    }) / probes,
  );

  return { clientMs, storeMs, candidates: candidates.length };
}

/** Tetto dichiarato da Cloudflare sul piano Free. */
export const FREE_CPU_LIMIT_MS = 10;

/** Unica fonte di verità per il budget operativo: quello usato in produzione. */
export { CPU_BUDGET_MS as SAFE_CPU_BUDGET_MS } from "../config/sources.ts";

/** Costo di una fonte in un tick, deduplica inclusa. */
function sourceCost(source: SourceBench, dedupeClientMs: number): number {
  return source.totalMs + dedupeClientMs * source.items;
}

/**
 * Simula la regola della pipeline: le fonti più care arrivano per prime (caso
 * peggiore), si leggono finché la CPU contata sta nel budget, la PRIMA fonte
 * parte sempre anche se da sola sfonda il budget, e il tetto di sicurezza su
 * MAX_SOURCES_PER_RUN resta un'ultima barriera.
 */
function simulateTick(
  ranked: SourceBench[],
  dedupeClientMs: number,
  maxSources: number,
): { sources: SourceBench[]; costMs: number } {
  const scelte: SourceBench[] = [];
  let costo = 0;
  for (const source of ranked) {
    if (scelte.length >= maxSources) break;
    const costoFonte = sourceCost(source, dedupeClientMs);
    if (scelte.length > 0 && costo + costoFonte > CPU_BUDGET_MS) break;
    scelte.push(source);
    costo += costoFonte;
  }
  return { sources: scelte, costMs: round(costo) };
}

export function summarise(sources: SourceBench[], dedupe: DedupeLookupBench, archiveSize: number): BenchReport {
  const ok = sources.filter((source) => source.error === null);
  // Peggiore dei casi: le fonti più care, e TUTTI gli item da arricchire (primo giro).
  const ranked = [...ok].sort((a, b) => b.totalMs - a.totalMs);
  const tick = simulateTick(ranked, dedupe.clientMs, MAX_SOURCES_PER_RUN);
  const senzaTetto = simulateTick(ranked, dedupe.clientMs, ranked.length);
  const extra = ranked[tick.sources.length] ?? null;
  const itemsInInvocation = tick.sources.reduce((sum, source) => sum + source.items, 0);
  const invocationMs = tick.costMs;
  const perItemMs = itemsInInvocation > 0 ? round(invocationMs / itemsInInvocation) : 0;
  const worstSourceMs = round(ranked[0]?.totalMs ?? 0);
  // Quante fonti del tipo peggiore entrano nel budget: è da qui che si sceglie il
  // tetto, senza indovinare.
  const sourcesFittingBudget = senzaTetto.sources.length;

  let verdict: string;
  if (invocationMs <= CPU_BUDGET_MS) {
    verdict =
      `OK: ${invocationMs} ms stimati per tick contro ${FREE_CPU_LIMIT_MS} ms disponibili ` +
      `(budget prudente ${CPU_BUDGET_MS} ms): nel budget entrano ${sourcesFittingBudget} fonti piene.`;
  } else if (invocationMs <= FREE_CPU_LIMIT_MS) {
    verdict =
      `AL LIMITE: ${invocationMs} ms per tick su ${FREE_CPU_LIMIT_MS} ms — una sola fonte piena ` +
      `sfonda il budget prudente di ${CPU_BUDGET_MS} ms: lascia il freno attivo.`;
  } else {
    verdict =
      `SFORA: la prima fonte costa già ${invocationMs} ms contro ${FREE_CPU_LIMIT_MS} ms: ` +
      `serve ridurre i tetti per fonte (o Workers Paid).`;
  }

  return {
    sources, invocationMs, sourcesInInvocation: tick.sources.length, itemsInInvocation,
    perItemMs, worstSourceMs, sourcesFittingBudget,
    extraSourceId: extra?.sourceId ?? null,
    withExtraSourceMs: extra ? round(invocationMs + sourceCost(extra, dedupe.clientMs)) : invocationMs,
    dedupeClientMs: dedupe.clientMs, dedupeStoreMs: dedupe.storeMs, archiveSize, verdict,
  };
}

/** Scarica i corpi delle fonti (fuori dalle sezioni cronometrate). */
export async function downloadBodies(
  sources: SourceRow[],
  fetcher: FetchLike,
  userAgent: string,
): Promise<{ source: SourceRow; body: string }[]> {
  const bodies: { source: SourceRow; body: string }[] = [];
  for (const source of sources) {
    const response = await fetchText(source.url, { fetcher, userAgent, now: new Date() }, { timeoutMs: 10_000, maxRetries: 0 });
    if (response.ok && !response.notModified && response.body.length > 0) {
      bodies.push({ source, body: response.body });
    }
  }
  return bodies;
}
