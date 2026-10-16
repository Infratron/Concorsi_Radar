import type { AiBinding, FetchLike, SourceRow, SourceRunResult } from "./types.ts";
import type { Store } from "./db/store.ts";
import { CPU_BUDGET_MS, MAX_SOURCES_PER_RUN, SOURCES, USER_AGENT } from "./config/sources.ts";
import { ingestSource } from "./ingest/index.ts";
import { enrichWithRules, looksLikeContest } from "./enrich/rules.ts";
import { indexPageUrls, staleReason } from "./enrich/freshness.ts";
import { MAX_AI_CALLS_PER_RUN, enrichWithAi, mergeInsight, needsAi } from "./enrich/ai.ts";
import { applyWeights, baseScore } from "./enrich/score.ts";
import {
  isFullyEnriched,
  loadDuplicateCandidates,
  mergeDuplicate,
  pickDuplicate,
  prepareItem,
  toNewItem,
  touchDuplicate,
} from "./dedupe.ts";
import { fnv1a32, sourceNameTokens } from "./lib/text.ts";

/**
 * Orchestrazione dell'ingestione: sceglie quali fonti toccare in questa
 * esecuzione (rotazione, per restare nei 10 ms di CPU del piano Free), scarica,
 * deduplica, arricchisce, assegna il punteggio e registra l'esito.
 */

export interface PipelineDeps {
  store: Store;
  fetcher: FetchLike;
  ai?: AiBinding | null;
  userAgent?: string;
}

export interface IngestOptions {
  /** Quante fonti al massimo in questa esecuzione (default MAX_SOURCES_PER_RUN). */
  maxSources?: number;
  /**
   * Aggiungere le fonti presenti in config ma non ancora in D1 (comportamento
   * di default, così un deploy nuovo funziona subito). Metti false per usare
   * SOLO le fonti già in archivio: serve a test e prove ripetibili.
   */
  includeSynthesized?: boolean;
  /**
   * Millisecondi di CPU concessi a questa esecuzione (default CPU_BUDGET_MS).
   * I test lo alzano per non dipendere dal tempo di parete della macchina; il
   * deploy usa sempre il default, tarato sui 10 ms del piano Free.
   */
  cpuBudgetMs?: number;
  /**
   * Ignora la rotazione a slot e prende tutte le fonti abilitate, dalla più
   * trascurata. Serve alla raccolta che gira su GitHub Actions: lì non c'è il
   * limite di CPU del piano Free, e una cadenza fissa (es. ogni 30 minuti)
   * cadrebbe sempre nello stesso slot di `dueSources`, lasciando metà delle
   * fonti invisibili per sempre.
   */
  allSources?: boolean;
}

export interface IngestSummary {
  sourcesDue: number;
  sourcesOk: number;
  sourcesFail: number;
  itemsSeen: number;
  itemsNew: number;
  duplicates: number;
  /** Item scartati perché non parlano di concorsi (tipico delle fonti news). */
  filtered: number;
  /**
   * Item scartati perché non sono concorsi ANCORA ATTIVI: pagine di catalogo,
   * edizione di un anno passato, pagina indice, promozione chiusa da mesi.
   * Vedi src/enrich/freshness.ts.
   */
  stale: number;
  /** Fonti saltate o item rimandati perché il budget di CPU era esaurito. */
  deferred: number;
  /** CPU stimata dell'esecuzione (ms): è la metrica da tenere sotto i 10 ms Free. */
  cpuMs: number;
  /** true al primo giro in assoluto: l'archivio era vuoto. */
  archiveWasEmpty: boolean;
  ms: number;
  notes: string[];
  deadSources: string[];
}

/** Un tick di rotazione dura 15 minuti, come il cron principale. */
const SLOT_MS = 15 * 60 * 1000;
/** Dopo 3 fallimenti consecutivi avvisiamo una volta sola e la fonte resta lì. */
export const DEAD_SOURCE_ALERT_AFTER = 3;

export function shardsFor(cadenceMin: number): number {
  const cadence = Number.isFinite(cadenceMin) ? Math.max(15, cadenceMin) : 15;
  return Math.max(1, Math.round(cadence / 15));
}

/**
 * Fonti dovute in questo tick: ogni fonte ha uno slot stabile (hash dell'id),
 * così il carico è distribuito e non ci sono tutte le fonti nello stesso giro.
 * Le più "trascurate" passano per prime, e si taglia a MAX_SOURCES_PER_RUN.
 */
export function dueSources(sources: SourceRow[], now: Date, max = MAX_SOURCES_PER_RUN): SourceRow[] {
  const tick = Math.floor(now.getTime() / SLOT_MS);
  return sources
    .filter((source) => {
      if (!source.enabled) return false;
      const shards = shardsFor(source.cadenceMin);
      return tick % shards === fnv1a32(source.id) % shards;
    })
    .sort((a, b) => (a.lastRunAt ?? "").localeCompare(b.lastRunAt ?? ""))
    .slice(0, Math.max(1, max));
}

/**
 * Il file di configurazione resta la fonte di verità per come si legge una
 * fonte (pattern, tetti); D1 conserva lo stato (etag, ultimo giro, fallimenti).
 * Una fonte in config ma non ancora seminata in D1 funziona comunque, solo
 * senza cache ETag e senza conteggio dei fallimenti finché non lanci db:seed.
 */
export function resolveSource(row: SourceRow): SourceRow {
  const config = SOURCES.find((candidate) => candidate.id === row.id);
  if (!config) return row;
  return {
    ...row,
    includePattern: config.includePattern,
    maxItems: config.maxItems,
  };
}

function synthesizedRow(configId: string): SourceRow | null {
  const config = SOURCES.find((candidate) => candidate.id === configId);
  if (!config) return null;
  return { ...config, etag: null, lastModified: null, lastRunAt: null, lastOkAt: null, failStreak: 0 };
}

/** Pesi appresi sommati su tutte le chat attive (bot personale: di norma una sola). */
export async function mergedWeights(store: Store): Promise<Record<string, number>> {
  const weights: Record<string, number> = {};
  for (const chatId of await store.listChats()) {
    const prefs = await store.getPrefs(chatId);
    if (!prefs) continue;
    for (const [tag, value] of Object.entries(prefs.weights)) {
      weights[tag] = (weights[tag] ?? 0) + value;
    }
  }
  return weights;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Chiave con cui raggruppare i motivi nelle note: "pagina ferma da 471 giorni"
 * e "pagina ferma da 300 giorni" sono lo stesso problema, non due.
 */
function motivoChiave(motivo: string): string {
  return motivo.replace(/ \([^)]*\)$/, "").replace(/ da \d+ giorni$/, "");
}

export async function runIngest(
  deps: PipelineDeps,
  now: Date,
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const started = Date.now();
  const notes: string[] = [];
  const deadSources: string[] = [];
  const userAgent = deps.userAgent ?? USER_AGENT;

  // Il freno conta SOLO il lavoro CPU delle nostre funzioni (parsing,
  // preparazione, arricchimento): performance.now() da solo misura il tempo di
  // parete, che include le attese di rete e non va contato — su Workers Free il
  // limite di 10 ms è di CPU, non di durata dell'invocazione.
  let cpuProxyMs = 0;
  const budgetMs = options.cpuBudgetMs ?? CPU_BUDGET_MS;
  const cpuStart = (): number => performance.now();
  const overBudget = (): boolean => cpuProxyMs > budgetMs;

  const archiveWasEmpty = (await deps.store.queryItems({ limit: 1 })).length === 0;
  const rows = await deps.store.getSources();
  const known = new Set(rows.map((row) => row.id));
  const synthesized =
    options.includeSynthesized === false
      ? []
      : SOURCES.filter((config) => config.enabled && !known.has(config.id))
          .map((config) => synthesizedRow(config.id))
          .filter((row): row is SourceRow => row !== null);
  if (synthesized.length > 0) {
    notes.push(`${synthesized.length} fonti non presenti in D1: esegui npm run db:seed per conservarne lo stato`);
  }

  const pool = [...rows, ...synthesized].map(resolveSource);
  const due = options.allSources
    ? pool
        .filter((source) => source.enabled)
        .sort((a, b) => (a.lastRunAt ?? "").localeCompare(b.lastRunAt ?? ""))
        .slice(0, Math.max(1, options.maxSources ?? pool.length))
    : dueSources(pool, now, options.maxSources ?? MAX_SOURCES_PER_RUN);
  const weights = await mergedWeights(deps.store);

  let sourcesOk = 0;
  let sourcesFail = 0;
  let itemsSeen = 0;
  let itemsNew = 0;
  let duplicates = 0;
  let filtered = 0;
  let stale = 0;
  let deferred = 0;
  let aiCalls = 0;

  for (const source of due) {
    // Freno di CPU: se il budget è finito, la fonte resta al giro successivo.
    // Non viene registrata come eseguita, quindi la rotazione la ripesca subito
    // (ordina per lastRunAt più vecchio).
    if (overBudget()) {
      deferred++;
      notes.push(`${source.id}: rimandata (budget CPU esaurito)`);
      continue;
    }

    let result: SourceRunResult;
    try {
      result = await ingestSource(source, { store: deps.store, fetcher: deps.fetcher, userAgent }, now);
    } catch (error) {
      result = {
        sourceId: source.id, httpStatus: null, notModified: false, robotsDenied: false,
        items: [], etag: null, lastModified: null, error: errorMessage(error), parseMs: 0,
      };
    }

    cpuProxyMs += result.parseMs;

    const ok = result.error === null;
    await deps.store.recordSourceRun(source.id, {
      ok,
      httpStatus: result.httpStatus,
      etag: result.etag,
      lastModified: result.lastModified,
      error: result.error,
      now: now.toISOString(),
    });

    if (ok) sourcesOk++;
    else {
      sourcesFail++;
      notes.push(`${source.id}: ${result.error}`);
      if (source.failStreak + 1 === DEAD_SOURCE_ALERT_AFTER) deadSources.push(source.id);
    }
    if (result.robotsDenied) notes.push(`${source.id}: robots.txt vieta la raccolta, saltata`);

    const nomeFonte = sourceNameTokens(source.name);
    // Fonti di elenco (sitemap e pagine HTML): il titolo è ricavato dall'URL e non
    // c'è testo di pagina, quindi due controlli che valgono solo per loro — una
    // pagina che è la cartella di altre pagine raccolte è un elenco, non un
    // concorso, e il cancello di freschezza può contare solo sulle parole
    // dell'URL.
    const elenco = source.kind === "sitemap" || source.kind === "html";
    const indice = elenco ? indexPageUrls(result.items.map((item) => item.url)) : new Set<string>();
    const motivi = new Map<string, number>();
    let saltati = 0;
    let primo = true;
    for (const raw of result.items) {
      // Budget di CPU: gli item rimasti restano alla prossima lettura della
      // fonte. I nuovi arrivano in cima ai feed, quindi si perdono solo le code
      // vecchie, che il digest avrebbe comunque ripresentato.
      //
      // Il primo item però si lavora sempre, anche se il parsing da solo ha già
      // sfondato il budget: senza questa garanzia una fonte più pesante del
      // budget verrebbe scaricata e rimandata a ogni giro senza mai ingerire
      // nulla (livelock). Il costo in più è un item, non un'altra fonte.
      if (!primo && overBudget()) {
        deferred++;
        saltati++;
        continue;
      }
      primo = false;
      itemsSeen++;
      // Le fonti news (Google News) pescano anche articoli che non sono concorsi:
      // senza questo filtro il digest si riempie di notizie fuori tema.
      if (source.kind === "news" && !looksLikeContest(`${raw.title} ${raw.summary}`)) {
        filtered++;
        continue;
      }
      // Prima di ogni altra cosa (e prima di spendere query di deduplica): una
      // pagina che è la cartella di altre pagine raccolte è un elenco.
      if (indice.has(raw.url)) {
        stale++;
        motivi.set("pagina indice", (motivi.get("pagina indice") ?? 0) + 1);
        continue;
      }
      try {
        // Nel conteggio entra solo la parte sincrona: la query dei candidati è
        // I/O (su D1 filtra SQL), la decisione sui candidati invece è CPU nostra.
        const prepareStart = cpuStart();
        const prepared = await prepareItem(raw, nomeFonte);
        cpuProxyMs += performance.now() - prepareStart;
        const candidates = await loadDuplicateCandidates(deps.store, prepared, now);
        const dedupeStart = cpuStart();
        const existing = pickDuplicate(candidates, prepared);
        cpuProxyMs += performance.now() - dedupeStart;

        if (existing) {
          duplicates++;
          // Percorso caldo del regime: se è già completo si evita del tutto
          // l'arricchimento (è la voce più costosa per item).
          if (isFullyEnriched(existing)) {
            await touchDuplicate(deps.store, existing, now);
            continue;
          }
          const enrichStart = cpuStart();
          const insight = enrichWithRules(raw, source, now);
          const score = applyWeights(baseScore(insight, raw, now), insight.tags, weights);
          cpuProxyMs += performance.now() - enrichStart;
          await mergeDuplicate(deps.store, existing, insight, score, now);
          continue;
        }

        const enrichStart = cpuStart();
        let insight = enrichWithRules(raw, source, now);
        // Il cancello di "concorso ancora attivo" sta PRIMA dell'AI: una pagina
        // chiusa anni fa non merita una chiamata al modello, e l'AI costa.
        const motivo = staleReason(
          {
            title: raw.title,
            url: raw.url,
            summary: raw.summary,
            publishedAt: raw.publishedAt,
            deadline: insight.deadline,
            fromListing: elenco,
          },
          now,
        );
        if (motivo !== null) {
          stale++;
          const chiave = motivoChiave(motivo);
          motivi.set(chiave, (motivi.get(chiave) ?? 0) + 1);
          continue;
        }
        if (deps.ai && aiCalls < MAX_AI_CALLS_PER_RUN && needsAi(insight, raw)) {
          aiCalls++;
          const patch = await enrichWithAi({ title: raw.title, summary: raw.summary }, {
            ai: deps.ai, store: deps.store, now,
          });
          if (patch) insight = mergeInsight(insight, patch);
        }

        const score = applyWeights(baseScore(insight, raw, now), insight.tags, weights);
        cpuProxyMs += performance.now() - enrichStart;
        const inserted = await deps.store.insertItem(toNewItem(raw, prepared, insight, score, now));
        if (inserted.created) itemsNew++;
      } catch (error) {
        notes.push(`${source.id}: item scartato (${errorMessage(error)})`);
      }
    }
    if (saltati > 0) notes.push(`${source.id}: ${saltati} item rimandati (budget CPU)`);
    const nonAttivi = [...motivi.values()].reduce((total, quante) => total + quante, 0);
    if (nonAttivi > 0) {
      // Il motivo entra nella nota: una fonte di elenco che smette di portare
      // item si capisce da qui, senza aprire la pagina a mano.
      const riassunto = [...motivi.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([motivo, quante]) => `${quante} ${motivo}`)
        .join(", ");
      notes.push(`${source.id}: ${nonAttivi} scartati, non attivi (${riassunto})`);
    }
  }

  return {
    sourcesDue: due.length, sourcesOk, sourcesFail, itemsSeen, itemsNew, duplicates,
    filtered, stale, deferred, archiveWasEmpty, cpuMs: Math.round(cpuProxyMs * 100) / 100,
    ms: Date.now() - started, notes, deadSources,
  };
}

/** Marca come 'expired' i concorsi scaduti da più di 3 giorni: pulizia periodica. */
export async function expireOldItems(store: Store, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const stale = await store.queryItems({ deadlineBefore: cutoff, statuses: ["new", "sent"], limit: 100 });
  for (const item of stale) await store.setStatus(item.id, "expired");
  return stale.length;
}
