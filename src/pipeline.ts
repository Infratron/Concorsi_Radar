import type { AiBinding, FetchLike, IngestContext, RawItem, SourceAttempt, SourceRow, SourceRunResult } from "./types.ts";
import type { Store } from "./db/store.ts";
import { CPU_BUDGET_MS, MAX_RULES_LOOKUPS_PER_RUN, MAX_SOURCES_PER_RUN, SOURCES, USER_AGENT } from "./config/sources.ts";
import { ingestSource, robotsAllows } from "./ingest/index.ts";
import { regulationUrlFromPage, regulationUrlFromText } from "./enrich/regulation.ts";
import { enrichWithRules, looksLikeContest } from "./enrich/rules.ts";
import { COUPON_TTL_DAYS, indexPageUrls, staleReason } from "./enrich/freshness.ts";
import { MAX_AI_CALLS_PER_RUN, enrichWithAi, mergeInsight, needsAi } from "./enrich/ai.ts";
import { applyBrandBonus, applyWeights, baseScore } from "./enrich/score.ts";
import {
  type PreparedItem,
  isFullyEnriched,
  loadDuplicateCandidates,
  mergeDuplicate,
  pickDuplicate,
  prepareItem,
  toNewItem,
  touchDuplicate,
  upgradeTitle,
} from "./dedupe.ts";
import { sightingFor } from "./enrich/lead.ts";
import { fnv1a32, sourceNameTokens } from "./lib/text.ts";
import { ROBOTS_DENIED_REASON } from "./lib/robots.ts";

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
  /**
   * Millisecondi di tempo di PARETE che la ricerca dei regolamenti può spendere
   * in questo giro (default RULES_LOOKUP_BUDGET_MS). È un tetto diverso dal
   * budget di CPU: l'attesa di rete non è CPU, ma nel Worker il tick del cron ha
   * un tempo massimo di esecuzione — una pagina che non risponde non deve poter
   * mangiare il giro. La raccolta su Actions lo alza: lì quel muro non c'è.
   */
  rulesLookupMs?: number;
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
  /**
   * L'esito di ogni fonte toccata in QUESTO giro, nell'ordine in cui è stata
   * provata: è il dato del report delle prime raccolte. Le fonti rimandate per
   * budget non entrano qui (non sono state provate) e si contano con `deferred`.
   */
  attempts: SourceAttempt[];
}

/** Un tick di rotazione dura 15 minuti, come il cron principale. */
const SLOT_MS = 15 * 60 * 1000;
/**
 * Quanto tempo di parete, al massimo, la ricerca dei regolamenti può spendere in
 * un giro. Otto secondi sono tarati sul tick del Worker (che ha un tempo massimo
 * di esecuzione) e sul caso peggiore: una pagina che accetta la connessione e non
 * risponde mai costa il timeout di 8 s, quindi con questo tetto la ricerca non
 * può far morire il giro. La raccolta su Actions passa un valore più alto.
 */
export const RULES_LOOKUP_BUDGET_MS = 8_000;
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
  return {
    ...config,
    etag: null,
    lastModified: null,
    lastRunAt: null,
    lastOkAt: null,
    failStreak: 0,
    lastStatus: null,
    lastError: null,
    lastItems: 0,
  };
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

/**
 * Le marche seguite da tutte le chat attive, unite: è l'insieme che decide il
 * bonus di punteggio (src/enrich/score.ts). Sta qui accanto ai pesi appresi
 * perché è la stessa domanda — "cosa vuole questa installazione" — e perché
 * l'ingestione le legge insieme, una volta per giro.
 *
 * L'unione invece della media è voluta: due persone che seguono Ferrero non
 * devono contare il doppio, e una marca seguita da una sola vale per tutte le
 * righe dell'archivio (una riga non è di nessuno in particolare).
 */
export async function mergedBrands(store: Store): Promise<Set<string>> {
  const brands = new Set<string>();
  for (const chatId of await store.listChats()) {
    const prefs = await store.getPrefs(chatId);
    if (!prefs) continue;
    for (const brand of prefs.filters.favoriteBrands) brands.add(brand);
  }
  return brands;
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
  const attempts: SourceAttempt[] = [];
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
  const brands = await mergedBrands(deps.store);

  let sourcesOk = 0;
  let sourcesFail = 0;
  let itemsSeen = 0;
  let itemsNew = 0;
  let duplicates = 0;
  let filtered = 0;
  let stale = 0;
  let deferred = 0;
  let aiCalls = 0;

  // Registrazione delle viste: una riga per concorso e per fonte, ed è il dato da
  // cui nasce /vantaggio. Sta in un try di proposito — è una misura, e una misura
  // non deve poter costare un concorso: se la tabella non c'è ancora la riga manca
  // e il motivo resta nella nota del giro, invece di far scartare l'item.
  let visteNonRegistrate = false;
  // Le viste restano dei CONCORSI: /vantaggio misura di quanto arriviamo prima
  // degli aggregatori su quello su cui si partecipa, e un coupon visto da due
  // fonti non dice niente su quell'anticipo. Le fonti coupon si giudicano con
  // quello che portano in archivio (SourceStat), non con le viste.
  const registraVista = async (
    source: SourceRow,
    prepared: PreparedItem,
    itemId: number | null,
    kept: boolean,
  ): Promise<void> => {
    if (prepared.kind !== "contest") return;
    try {
      await deps.store.recordSighting(
        sightingFor({ urlKey: prepared.urlKey, sourceId: source.id, itemId, kind: prepared.kind, kept, now }),
      );
    } catch (error) {
      if (visteNonRegistrate) return;
      visteNonRegistrate = true;
      notes.push(`viste non registrate (${errorMessage(error)})`);
    }
  };

  /**
   * Il regolamento del concorso (il bando), da salvare sull'item: prima dal testo
   * che la fonte ci ha dato (gratis), poi — se lì non c'è — dalla pagina del
   * concorso, che è una richiesta in più.
   *
   * Perché vale una richiesta: il bottone 📄 Regolamento in chat compariva solo
   * quando il bando era scritto nel riassunto del feed, e un riassunto di due
   * righe non lo nomina quasi mai. Il bando però è quasi sempre un link dentro la
   * pagina del concorso, ed è l'unica cosa che l'utente cerca davvero quando il
   * concorso lo convince: senza, l'unica strada è leggersi la pagina a mano.
   *
   * Tetti e paletti, tutti dichiarati: si cerca solo per i CONCORSI (un coupon
   * non ha un bando), solo per gli item nuovi (i duplicati non costano una
   * richiesta), al massimo MAX_RULES_LOOKUPS_PER_RUN pagine per giro, mai se il
   * budget di CPU è finito, e solo dove robots.txt lo permette. Chi resta fuori
   * lo prende `npm run rules -- --apply`.
   */
  let ricercheRegolamento = 0;
  let regolamentiTrovati = 0;
  let tempoRegolamenti = 0;
  const budgetRegolamenti = options.rulesLookupMs ?? RULES_LOOKUP_BUDGET_MS;
  const regolamentoPer = async (raw: RawItem, prepared: PreparedItem): Promise<string | null> => {
    if (prepared.kind !== "contest") return null;

    const dalTesto = regulationUrlFromText(raw.summary, prepared.url);
    if (dalTesto !== null) return dalTesto;

    if (ricercheRegolamento >= MAX_RULES_LOOKUPS_PER_RUN || tempoRegolamenti >= budgetRegolamenti || overBudget()) {
      return null;
    }
    ricercheRegolamento++;

    const ctx: IngestContext = { fetcher: deps.fetcher, userAgent, now };
    // Solo la scansione è CPU (la rete no): è l'unica parte da contare nel budget,
    // come per ogni altro parsing di questa pipeline. La richiesta si conta
    // prima, perché il tetto per giro guarda quante pagine si sono lette.
    const scanStart = cpuStart();
    const link = await regulationUrlFromPage(prepared.url, {
      fetcher: deps.fetcher,
      userAgent,
      allows: (url) => robotsAllows(url, { store: deps.store, fetcher: deps.fetcher, userAgent }, ctx, now),
      now,
    });
    // Il tempo speso si conta comunque, anche quando il bando non c'è: è il muro
    // che impedisce a una pagina lenta di mangiare il giro.
    tempoRegolamenti += performance.now() - scanStart;
    cpuProxyMs += performance.now() - scanStart;
    if (link !== null) regolamentiTrovati++;
    return link;
  };

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
      error: result.error ?? (result.robotsDenied ? ROBOTS_DENIED_REASON : null),
      // Quanti item GREZZI ha portato la fonte, prima di ogni filtro: è il numero
      // che distingue "ha risposto ed è vuota" da "non ha risposto".
      items: result.items.length,
      now: now.toISOString(),
    });
    attempts.push({
      sourceId: source.id,
      name: source.name,
      at: now.toISOString(),
      httpStatus: result.httpStatus,
      items: result.items.length,
      notModified: result.notModified,
      robotsDenied: result.robotsDenied,
      error: result.error,
    });

    if (ok) sourcesOk++;
    else {
      sourcesFail++;
      notes.push(`${source.id}: ${result.error}`);
      if (source.failStreak + 1 === DEAD_SOURCE_ALERT_AFTER) deadSources.push(source.id);
    }
    if (result.robotsDenied) notes.push(`${source.id}: ${ROBOTS_DENIED_REASON}, saltata`);

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
        const prepared = await prepareItem(raw, nomeFonte, source.kind, source.category);
        cpuProxyMs += performance.now() - prepareStart;
        const candidates = await loadDuplicateCandidates(deps.store, prepared, now);
        const dedupeStart = cpuStart();
        const existing = pickDuplicate(candidates, prepared);
        cpuProxyMs += performance.now() - dedupeStart;

        if (existing) {
          duplicates++;
          // La copia dell'aggregatore è il caso più frequente del regime, ed è
          // esattamente la riga che rende misurabile l'anticipo.
          await registraVista(source, prepared, existing.id, true);
          // Un duplicato non crea una seconda riga, ma può portare un nome
          // migliore: la copia con il titolo più completo lo sostituisce.
          await upgradeTitle(deps.store, existing, prepared);
          // Il bando scritto nel testo si salva anche su una riga che è già in
          // archivio: non costa una richiesta, e una riga che ce l'ha non si
          // tocca (l'archivio ha il valore più vecchio e più completo — il
          // riassunto di oggi è già stato troncato).
          if (existing.rulesUrl === null) {
            const dalTesto = regulationUrlFromText(raw.summary, prepared.url);
            if (dalTesto !== null) await deps.store.updateItem(existing.id, { rulesUrl: dalTesto });
          }
          // Percorso caldo del regime: se è già completo si evita del tutto
          // l'arricchimento (è la voce più costosa per item).
          if (isFullyEnriched(existing)) {
            await touchDuplicate(deps.store, existing, now);
            continue;
          }
          const enrichStart = cpuStart();
          const insight = enrichWithRules(raw, source, now);
          // Il bonus si calcola sulla marca che la riga avrà DOPO l'unione: se
          // quella in archivio c'è già è la sua, altrimenti è quella appena
          // riconosciuta.
          const score = applyBrandBonus(
            applyWeights(baseScore(insight, raw, now), insight.tags, weights),
            existing.brand ?? prepared.brand,
            brands,
          );
          cpuProxyMs += performance.now() - enrichStart;
          await mergeDuplicate(deps.store, existing, insight, score, now, prepared.brand);
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
            kind: prepared.kind,
          },
          now,
        );
        if (motivo !== null) {
          stale++;
          // Visto e buttato: si registra con kept=false, così /vantaggio può dire
          // anche quanti concorsi l'archivio ha visto e non ha tenuto.
          await registraVista(source, prepared, null, false);
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

        const score = applyBrandBonus(
          applyWeights(baseScore(insight, raw, now), insight.tags, weights),
          prepared.brand,
          brands,
        );
        cpuProxyMs += performance.now() - enrichStart;
        // Il regolamento si cerca dopo il punteggio e prima dell'inserimento: è
        // l'ultimo dato che vale una richiesta, e chi non lo trova resta senza
        // bottone (mai un link inventato).
        const rulesUrl = await regolamentoPer(raw, prepared);
        const inserted = await deps.store.insertItem(toNewItem(raw, prepared, insight, score, now, rulesUrl));
        if (inserted.created) itemsNew++;
        await registraVista(source, prepared, inserted.item.id, true);
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

  if (ricercheRegolamento > 0) {
    // Il numero sta nella nota perché è l'unico modo per accorgersi che il tetto
    // per giro è basso (o che le pagine non rispondono più).
    notes.push(`regolamenti: ${regolamentiTrovati} trovati su ${ricercheRegolamento} pagine lette`);
  }

  return {
    sourcesDue: due.length, sourcesOk, sourcesFail, itemsSeen, itemsNew, duplicates,
    filtered, stale, deferred, archiveWasEmpty, cpuMs: Math.round(cpuProxyMs * 100) / 100,
    ms: Date.now() - started, notes, deadSources, attempts,
  };
}

/**
 * Pulizia periodica: marca 'expired' i concorsi scaduti da più di 3 giorni e i
 * coupon che non sono più spendibili (COUPON_TTL_DAYS, src/enrich/freshness.ts —
 * la stessa regola che li tiene fuori all'ingresso).
 */
export async function expireOldItems(store: Store, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const stale = await store.queryItems({ deadlineBefore: cutoff, statuses: ["new", "sent"], limit: 100 });
  for (const item of stale) await store.setStatus(item.id, "expired");
  // I coupon si contano dall'ingresso in archivio (`until`), non da una scadenza
  // che non hanno: la stessa query che li mostra in 💶 Coupon li fa invecchiare.
  const couponCutoff = new Date(now.getTime() - COUPON_TTL_DAYS * 86_400_000).toISOString();
  const coupons = await store.queryItems({
    kinds: ["coupon"],
    until: couponCutoff,
    statuses: ["new", "sent"],
    limit: 100,
  });
  for (const item of coupons) await store.setStatus(item.id, "expired");
  return stale.length + coupons.length;
}
