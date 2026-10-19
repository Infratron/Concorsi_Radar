import type { SourceStat, Store } from "./store.ts";
import type {
  DedupeRow,
  ItemKind,
  ItemPatch,
  ItemQuery,
  ItemRow,
  ItemStatus,
  NavPoint,
  NewItem,
  Prefs,
  ReceiptRow,
  RefundRow,
  RefundTotals,
  RobotsRow,
  RunRow,
  Sighting,
  SourceRow,
  UiState,
} from "../types.ts";
import type { Flyer } from "../volantini.ts";
import { DUP_WINDOW_MAX_ROWS, nearestBySimhash } from "../lib/text.ts";
import { defaultFilters, parseFilters } from "../filters.ts";

/**
 * Implementazione dello Store su Cloudflare D1 (produzione).
 * Tutti i valori passano da parametri BOUND: nessuna interpolazione di stringhe.
 *
 * Lo SQL qui è l'unica copia che esiste: `createD1Store` accetta un `D1Like`, cioè
 * il minimo che usiamo del binding D1. Il binding vero (`env.DB`) lo soddisfa
 * strutturalmente, e lo stesso vale per l'adattatore via API HTTP usato dalla
 * raccolta su GitHub Actions (src/db/d1-http.ts). Così il Worker e il job di
 * raccolta eseguono letteralmente le stesse query.
 */

/** Statement D1: solo i metodi che usiamo davvero. */
export interface D1LikeStatement {
  bind(...params: unknown[]): D1LikeStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

/** Il binding D1 visto dal nostro codice: prepare non fa altro che questo. */
export interface D1Like {
  prepare(sql: string): D1LikeStatement;
}

/** Righe come escono da D1 (snake_case, booleani come 0/1, array come JSON). */
interface ItemDbRow {
  id: number;
  source_id: string;
  /** Assente su un database antecedente alla migrazione: si legge come "non so". */
  brand?: string | null;
  kind: string;
  url: string;
  url_key: string;
  simhash: string;
  title: string;
  summary: string;
  published_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  deadline: string | null;
  prize: string | null;
  participation: string | null;
  /** Assente su un database antecedente alla migrazione: vedi src/db/schema.sql. */
  rules_url?: string | null;
  prize_value: number;
  effort: number;
  requires_purchase: number;
  tags: string;
  score: number;
  cluster_id: number | null;
  status: string;
  ai_used: number;
}

interface SourceDbRow {
  id: string;
  name: string;
  kind: string;
  url: string;
  category: string;
  tags: string;
  cadence_min: number;
  enabled: number;
  /** Assenti su un database antecedente alla migrazione: vedi src/db/schema.sql. */
  include_pattern?: string | null;
  max_items?: number | null;
  etag: string | null;
  last_modified: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  fail_streak: number;
  /** Assenti su un database antecedente alla migrazione: vedi src/db/schema.sql. */
  last_status?: number | null;
  last_error?: string | null;
  last_items?: number | null;
}

interface PrefsDbRow {
  chat_id: number;
  active: number;
  weights: string;
  min_score_instant: number;
  quiet_hours: string;
  digest_hours: string;
  /** Assente su un database antecedente alla colonna: vale "spenti". */
  instant_alerts?: number | null;
  /** JSON dei filtri della chat. Assente su un database antecedente alla colonna. */
  filters?: string | null;
  /** Ora del promemoria del giro; assente o NULL = spento. */
  giro_hour?: number | null;
}

interface FlyerDbRow {
  chain: string;
  url: string;
  valid_from: string | null;
  valid_to: string | null;
  cover_url: string | null;
  checked_at: string;
  changed_at: string | null;
  status: number | null;
}

interface ReceiptDbRow {
  id: number;
  chat_id: number;
  item_id: number;
  file_id: string;
  file_unique_id: string;
  media: string;
  added_at: string;
}

function rowToReceipt(row: ReceiptDbRow): ReceiptRow {
  return {
    id: row.id,
    chatId: row.chat_id,
    itemId: row.item_id,
    fileId: row.file_id,
    fileUniqueId: row.file_unique_id,
    media: row.media === "document" ? "document" : "photo",
    addedAt: row.added_at,
  };
}

interface SightingDbRow {
  url_key: string;
  source_id: string;
  item_id: number | null;
  kind: string;
  channel: string;
  seen_at: string;
  kept: number;
}

interface RefundDbRow extends ItemDbRow {
  refund_amount_cents: number;
  refund_cap: number;
  refund_claimed_at: string;
  refund_received_at: string | null;
}

interface UiDbRow {
  chat_id: number;
  message_id: number | null;
  section: string;
  page: number;
  open_item_id: number | null;
  last_check_at: string | null;
  /** JSON della storia di navigazione; null/assente nelle righe vecchie. */
  history: string | null;
  updated_at: string;
}

/**
 * La storia di navigazione dal JSON: si accetta solo la forma che conosciamo.
 * Una riga corrotta non deve far esplodere la schermata — al massimo si perde il
 * ritorno indietro di quella chat, e il bottone ripiega sul genitore.
 */
function parseNavPoints(value: string | null | undefined): NavPoint[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (punto): punto is NavPoint =>
          typeof punto === "object" &&
          punto !== null &&
          typeof (punto as { section?: unknown }).section === "string" &&
          typeof (punto as { page?: unknown }).page === "number",
      )
      .map((punto) => ({ section: punto.section, page: punto.page }))
      .slice(-8);
  } catch {
    return [];
  }
}

interface RunDbRow {
  started_at: string;
  trigger: string;
  sources_ok: number;
  sources_fail: number;
  items_new: number;
  ms: number;
  note: string | null;
  log: string | null;
}

interface RobotsDbRow {
  origin: string;
  body: string;
  fetched_at: string;
}

interface AiUsageDbRow {
  neurons: number;
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseNumberRecord(raw: unknown): Record<string, number> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function parseNumberArray(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

/**
 * Il tipo salvato nella colonna `kind`. Un valore inatteso (database non ancora
 * aggiornato, riga scritta a mano) vale "concorso": è il significato di default
 * della colonna e l'unico che non nasconde una riga alle statistiche.
 * I tre valori sono quelli di ItemKind: concorso, coupon, articolo.
 */
function itemKind(raw: unknown): ItemKind {
  return raw === "news" || raw === "coupon" ? raw : "contest";
}

function rowToItem(row: ItemDbRow): ItemRow {
  return {
    id: row.id,
    sourceId: row.source_id,
    // Come per le colonne di `sources`: un database non ancora migrato risponde
    // `undefined`, e "non lo so" è un valore legittimo (una marca non
    // riconosciuta), non un motivo per rompere la lettura.
    brand: row.brand ?? null,
    // Un valore inatteso non deve mai arrivare all'interfaccia: resta un concorso.
    kind: itemKind(row.kind),
    url: row.url,
    urlKey: row.url_key,
    simhash: row.simhash,
    title: row.title,
    summary: row.summary,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    deadline: row.deadline,
    prize: row.prize,
    participation: row.participation,
    // Come per la marca: un database non ancora migrato risponde `undefined`, e
    // "non lo so" è legittimo (nessun regolamento salvato) — la chat ricade sul
    // testo dell'item.
    rulesUrl: row.rules_url ?? null,
    prizeValue: row.prize_value,
    effort: row.effort,
    requiresPurchase: row.requires_purchase === 1,
    tags: parseStringArray(row.tags),
    score: row.score,
    clusterId: row.cluster_id,
    status: row.status as ItemStatus,
    aiUsed: row.ai_used === 1,
  };
}

/**
 * Un rimborso: la riga dell'offerta più le quattro colonne della richiesta.
 * La JOIN porta l'item intero (come listDeliveredItems): la schermata mostra il
 * titolo e la scheda ha già tutto, senza una query per riga.
 */
function rowToRefund(row: RefundDbRow, chatId: number): RefundRow {
  return {
    chatId,
    itemId: row.id,
    item: rowToItem(row),
    amountCents: row.refund_amount_cents ?? 0,
    cap: row.refund_cap === 1,
    claimedAt: row.refund_claimed_at,
    receivedAt: row.refund_received_at ?? null,
  };
}

function rowToSighting(row: SightingDbRow): Sighting {
  return {
    urlKey: row.url_key,
    sourceId: row.source_id,
    itemId: row.item_id,
    // Valore inatteso = concorso, come per gli item: è il significato di default
    // della colonna e l'unico che non nasconde una riga alle statistiche.
    kind: itemKind(row.kind),
    // Un canale scritto male vale "stampa", cioè resta fuori dal confronto:
    // meglio non contare una vista che contarla dalla parte sbagliata.
    channel: row.channel === "brand" || row.channel === "aggregatore" ? row.channel : "stampa",
    seenAt: row.seen_at,
    kept: row.kept === 1,
  };
}

function rowToSource(row: SourceDbRow): SourceRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SourceRow["kind"],
    url: row.url,
    category: row.category as SourceRow["category"],
    tags: parseStringArray(row.tags),
    cadenceMin: row.cadence_min,
    enabled: row.enabled === 1,
    // Come si legge la fonte viaggia con la riga: è il motivo per cui il pattern
    // sta in D1 e non solo nella configurazione (vedi src/db/schema.sql).
    ...(row.include_pattern ? { includePattern: row.include_pattern } : {}),
    ...(typeof row.max_items === "number" && row.max_items > 0 ? { maxItems: row.max_items } : {}),
    etag: row.etag,
    lastModified: row.last_modified,
    lastRunAt: row.last_run_at,
    lastOkAt: row.last_ok_at,
    failStreak: row.fail_streak,
    // Un database non ancora migrato risponde `undefined`: si legge come "non lo
    // so", non come un successo. Le colonne si aggiungono con le ALTER TABLE
    // scritte in src/db/schema.sql.
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    lastItems: row.last_items ?? 0,
  };
}

function rowToPrefs(row: PrefsDbRow): Prefs {
  return {
    chatId: row.chat_id,
    active: row.active === 1,
    weights: parseNumberRecord(row.weights),
    minScoreInstant: row.min_score_instant,
    quietHours: row.quiet_hours,
    digestHours: parseNumberArray(row.digest_hours),
    // Una riga scritta prima della colonna risponde `undefined`: si legge come
    // "spenti", che è il default di oggi (e il solo valore sicuro: mandare un
    // avviso a chi non l'ha mai acceso è l'errore che questa colonna evita).
    instantAlerts: row.instant_alerts === 1,
    filters: parseFilters(row.filters ?? null),
    giroHour: typeof row.giro_hour === "number" ? row.giro_hour : null,
  };
}

function rowToUiState(row: UiDbRow): UiState {
  // Storia vuota = proprietà assente, non `[]`: una riga vecchia (scritta prima
  // della colonna) e una nuova senza storia si leggono allo stesso modo, e le
  // due implementazioni dello Store restituiscono la stessa forma.
  const storia = parseNavPoints(row.history);
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    section: row.section,
    page: row.page,
    openItemId: row.open_item_id,
    ...(storia.length > 0 ? { history: storia } : {}),
    lastCheckAt: row.last_check_at,
    // La colonna c'è dalla prima versione della tabella, ma il campo è stato
    // letto solo adesso: un database scritto prima risponde `undefined`, e "non
    // lo so" resta scritto come tale invece di diventare una data inventata.
    updatedAt: row.updated_at ?? null,
  };
}

function rowToRun(row: RunDbRow): RunRow {
  return {
    startedAt: row.started_at,
    trigger: row.trigger,
    sourcesOk: row.sources_ok,
    sourcesFail: row.sources_fail,
    itemsNew: row.items_new,
    ms: row.ms,
    note: row.note,
    // Le righe scritte prima che la colonna esistesse non hanno un log: `null`,
    // non una stringa vuota (un log vuoto sarebbe un lancio senza fonti).
    log: row.log ?? null,
  };
}

/** Colonne di items, nell'ordine usato dagli INSERT. */
const ITEM_COLUMNS = [
  "source_id", "brand", "kind", "url", "url_key", "simhash", "title", "summary", "published_at",
  "first_seen_at", "last_seen_at", "deadline", "prize", "participation", "rules_url", "prize_value",
  "effort", "requires_purchase", "tags", "score", "cluster_id", "status", "ai_used",
];

/**
 * Whitelist degli ordinamenti: orderBy non finisce MAI in SQL come valore libero.
 * Ogni ordine finisce con `id DESC`: senza un ultimo criterio unico due righe a
 * pari punteggio possono uscire in ordine diverso fra una query e l'altra, e le
 * pagine della chat salterebbero o ripeterebbero un concorso.
 */
const ORDER_BY: Record<string, string> = {
  first_seen: "first_seen_at DESC, id DESC",
  score: "score DESC, first_seen_at DESC, id DESC",
  // NULL messi in fondo, così l'ordine coincide con l'implementazione in-memory.
  deadline: "deadline IS NULL ASC, deadline ASC, score DESC, id DESC",
  // Storico: chi ha chiuso per ultimo sta in cima.
  deadline_desc: "deadline IS NULL ASC, deadline DESC, id DESC",
};

/**
 * Clausola WHERE delle query su items, scritta in un punto solo: countItems deve
 * contare esattamente le righe che queryItems restituirebbe, e due copie della
 * stessa logica divergono alla prima aggiunta di un filtro.
 */
function buildWhere(query: ItemQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.since) {
    where.push("first_seen_at >= ?");
    params.push(query.since);
  }
  if (query.until) {
    where.push("first_seen_at <= ?");
    params.push(query.until);
  }
  if (query.statuses && query.statuses.length > 0) {
    where.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
    params.push(...query.statuses);
  }
  if (query.kinds && query.kinds.length > 0) {
    where.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`);
    params.push(...query.kinds);
  }
  if (typeof query.minScore === "number") {
    where.push("score >= ?");
    params.push(query.minScore);
  }
  const keyword = query.keyword?.trim().toLowerCase();
  if (keyword) {
    // In LIKE, `%` e `_` sono jolly. Chi cerca "50%" vuole quel testo, non
    // qualunque cosa: si escapano, così la ricerca resta un substring letterale
    // — la stessa semantica dell'implementazione in memoria (memory.ts), che
    // usa includes. Senza, due store rispondevano due cose diverse alla stessa
    // domanda, e solo i test sul memory store lo nascondevano.
    const literal = keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
    where.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(summary) LIKE ? ESCAPE '\\')");
    params.push(`%${literal}%`, `%${literal}%`);
  }
  if (query.withoutDeadline === true) {
    where.push("deadline IS NULL");
  }
  if (query.withoutRules === true) {
    where.push("rules_url IS NULL");
  }
  if (query.deadlineBefore) {
    where.push("deadline IS NOT NULL AND deadline <= ?");
    params.push(query.deadlineBefore);
  }
  if (query.deadlineAfter) {
    where.push("deadline IS NOT NULL AND deadline >= ?");
    params.push(query.deadlineAfter);
  }
  if (query.deadlineNotBefore) {
    // L'OR è il punto: chi non dichiara una validità non si può giudicare, e
    // resta in elenco (vedi ItemQuery.deadlineNotBefore).
    where.push("(deadline IS NULL OR deadline >= ?)");
    params.push(query.deadlineNotBefore);
  }
  if (query.excludeIds && query.excludeIds.length > 0) {
    where.push(`id NOT IN (${query.excludeIds.map(() => "?").join(", ")})`);
    params.push(...query.excludeIds);
  }
  if (query.excludeSources && query.excludeSources.length > 0) {
    where.push(`source_id NOT IN (${query.excludeSources.map(() => "?").join(", ")})`);
    params.push(...query.excludeSources);
  }
  if (query.excludeTags && query.excludeTags.length > 0) {
    // I tag sono un array JSON: si confrontano con json_each, non con LIKE.
    // Con LIKE un tag "moda" escluderebbe anche "moda_bambini", e un carattere
    // jolly dentro un tag cambierebbe la query invece di confrontarla.
    where.push(
      `NOT EXISTS (SELECT 1 FROM json_each(items.tags) AS tag WHERE tag.value IN (${query.excludeTags
        .map(() => "?")
        .join(", ")}))`,
    );
    params.push(...query.excludeTags);
  }
  if (query.tags && query.tags.length > 0) {
    // Inclusione: l'item entra se HA almeno uno di questi tag. Stesso json_each
    // dell'esclusione (con LIKE un tag "moda" prenderebbe anche "moda_bambini").
    where.push(
      `EXISTS (SELECT 1 FROM json_each(items.tags) AS tag WHERE tag.value IN (${query.tags
        .map(() => "?")
        .join(", ")}))`,
    );
    params.push(...query.tags);
  }
  if (query.withoutPurchase === true) {
    where.push("requires_purchase = 0");
  }
  if (query.withPurchase === true) {
    where.push("requires_purchase = 1");
  }
  if (query.brands && query.brands.length > 0) {
    where.push(`brand IN (${query.brands.map(() => "?").join(", ")})`);
    params.push(...query.brands);
  }
  if (query.excludeBrands && query.excludeBrands.length > 0) {
    // L'OR con NULL è voluto: un item senza marca non si può escludere, e
    // `brand NOT IN (...)` da solo lo farebbe sparire (NULL NOT IN → NULL).
    where.push(`(brand IS NULL OR brand NOT IN (${query.excludeBrands.map(() => "?").join(", ")}))`);
    params.push(...query.excludeBrands);
  }

  return { sql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function createD1Store(db: D1Like): Store {
  return {
    async getSources(): Promise<SourceRow[]> {
      const result = await db.prepare("SELECT * FROM sources ORDER BY name ASC").all<SourceDbRow>();
      return (result.results ?? []).map(rowToSource);
    },

    async recordSourceRun(id, result): Promise<void> {
      await db
        .prepare(
          `UPDATE sources
              SET etag = COALESCE(?, etag),
                  last_modified = COALESCE(?, last_modified),
                  last_run_at = ?,
                  fail_streak = CASE WHEN ? = 1 THEN 0 ELSE fail_streak + 1 END,
                  last_ok_at = CASE WHEN ? = 1 THEN ? ELSE last_ok_at END,
                  last_status = ?,
                  last_error = ?,
                  last_items = ?
            WHERE id = ?`,
        )
        .bind(
          result.etag,
          result.lastModified,
          result.now,
          result.ok ? 1 : 0,
          result.ok ? 1 : 0,
          result.now,
          result.httpStatus,
          result.error,
          result.items,
          id,
        )
        .run();
    },

    async findDuplicateCandidates(key, simhashValue, sinceIso, limit = 8): Promise<ItemRow[]> {
      const byKey = await db.prepare("SELECT * FROM items WHERE url_key = ?").bind(key).first<ItemDbRow>();
      if (byKey) return [rowToItem(byKey)];

      const candidates = await db
        .prepare("SELECT * FROM items WHERE first_seen_at >= ? ORDER BY first_seen_at DESC LIMIT ?")
        .bind(sinceIso, DUP_WINDOW_MAX_ROWS)
        .all<ItemDbRow>();
      return nearestBySimhash(candidates.results ?? [], simhashValue, limit).map(rowToItem);
    },

    async getItemByUrlKey(key: string): Promise<ItemRow | null> {
      const row = await db.prepare("SELECT * FROM items WHERE url_key = ?").bind(key).first<ItemDbRow>();
      return row ? rowToItem(row) : null;
    },

    async dedupeWindow(sinceIso: string, limit: number): Promise<DedupeRow[]> {
      const result = await db
        .prepare(
          "SELECT id, url_key, simhash, title FROM items WHERE first_seen_at >= ? ORDER BY first_seen_at DESC LIMIT ?",
        )
        .bind(sinceIso, Math.max(1, Math.trunc(limit)))
        .all<{ id: number; url_key: string; simhash: string; title: string }>();
      return (result.results ?? []).map((row) => ({ id: row.id, urlKey: row.url_key, simhash: row.simhash, title: row.title }));
    },

    async insertItem(item: NewItem): Promise<{ item: ItemRow; created: boolean }> {
      const placeholders = ITEM_COLUMNS.map(() => "?").join(", ");
      const values: unknown[] = [
        item.sourceId, item.brand ?? null, item.kind ?? "contest", item.url, item.urlKey, item.simhash, item.title, item.summary,
        item.publishedAt, item.firstSeenAt, item.lastSeenAt, item.deadline, item.prize,
        item.participation, item.rulesUrl ?? null, item.prizeValue, item.effort, item.requiresPurchase ? 1 : 0,
        JSON.stringify(item.tags), item.score, item.clusterId, item.status, item.aiUsed ? 1 : 0,
      ];
      const inserted = await db
        .prepare(
          `INSERT INTO items (${ITEM_COLUMNS.join(", ")}) VALUES (${placeholders})
           ON CONFLICT(url_key) DO NOTHING
           RETURNING *`,
        )
        .bind(...values)
        .all<ItemDbRow>();

      const created = (inserted.results ?? [])[0];
      if (created) return { item: rowToItem(created), created: true };

      const existing = await db.prepare("SELECT * FROM items WHERE url_key = ?").bind(item.urlKey).first<ItemDbRow>();
      if (!existing) {
        throw new Error(`insertItem: item ${item.urlKey} non inserito e non trovato`);
      }
      return { item: rowToItem(existing), created: false };
    },

    async updateItem(id: number, patch: ItemPatch): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (column: string, value: unknown): void => {
        sets.push(`${column} = ?`);
        params.push(value);
      };

      if (patch.lastSeenAt !== undefined) push("last_seen_at", patch.lastSeenAt);
      // La marca si scrive solo quando c'è: un duplicato senza marca riconosciuta
      // non deve cancellare quella già in archivio.
      if (patch.brand !== undefined && patch.brand !== null) push("brand", patch.brand);
      if (patch.title !== undefined) push("title", patch.title);
      if (patch.simhash !== undefined) push("simhash", patch.simhash);
      if (patch.kind !== undefined) push("kind", patch.kind);
      if (patch.deadline !== undefined) push("deadline", patch.deadline);
      if (patch.prize !== undefined) push("prize", patch.prize);
      if (patch.participation !== undefined) push("participation", patch.participation);
      // Come la marca: si scrive quando c'è, e un null non cancella il bando che
      // una raccolta precedente aveva già trovato.
      if (patch.rulesUrl !== undefined && patch.rulesUrl !== null) push("rules_url", patch.rulesUrl);
      if (patch.prizeValue !== undefined) push("prize_value", patch.prizeValue);
      if (patch.effort !== undefined) push("effort", patch.effort);
      if (patch.requiresPurchase !== undefined) push("requires_purchase", patch.requiresPurchase ? 1 : 0);
      if (patch.tags !== undefined) push("tags", JSON.stringify(patch.tags));
      if (patch.score !== undefined) push("score", patch.score);
      if (patch.clusterId !== undefined) push("cluster_id", patch.clusterId);
      if (patch.status !== undefined) push("status", patch.status);
      if (patch.aiUsed !== undefined) push("ai_used", patch.aiUsed ? 1 : 0);

      if (sets.length === 0) return;
      params.push(id);
      await db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
    },

    async getItem(id: number): Promise<ItemRow | null> {
      const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemDbRow>();
      return row ? rowToItem(row) : null;
    },

    async queryItems(query: ItemQuery): Promise<ItemRow[]> {
      const filter = buildWhere(query);
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), 200);
      const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
      const order = ORDER_BY[query.orderBy ?? "first_seen"] ?? ORDER_BY.first_seen;
      const sql = `SELECT * FROM items ${filter.sql} ORDER BY ${order} LIMIT ? OFFSET ?`;
      const result = await db.prepare(sql).bind(...filter.params, limit, offset).all<ItemDbRow>();
      return (result.results ?? []).map(rowToItem);
    },

    async countItems(query: ItemQuery): Promise<number> {
      // COUNT senza idratazione: i conteggi del menù non devono costare quanto
      // caricare le righe (su Workers Free la CPU è il vincolo).
      const filter = buildWhere(query);
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM items ${filter.sql}`)
        .bind(...filter.params)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async sourceStats(): Promise<Record<string, SourceStat>> {
      // Due letture, una per tabella: "che cosa è rimasto in archivio grazie a
      // lei" (items, dove source_id è chi l'ha trovato per primo) e "quanto ha
      // visto" (sightings, che registra ogni vista anche quando il concorso era
      // già noto). Sono due cose diverse di proposito: la seconda dice anche
      // quanto una fonte ripete gli altri.
      //
      // La prima conta concorsi E coupon (tutto tranne gli articoli): una fonte
      // di coupon che porta venti buoni sconto non è una fonte inutile, e con
      // `kind = 'contest'` la diagnostica le direbbe di no.
      const items = await db
        .prepare(
          `SELECT source_id, COUNT(*) AS n, MAX(first_seen_at) AS ultimo
           FROM items WHERE kind <> 'news' GROUP BY source_id`,
        )
        .all<{ source_id: string; n: number; ultimo: string | null }>();
      // La tabella delle viste è una misura, e una misura non deve poter rompere
      // la schermata: su un archivio antecedente alla sua creazione la diagnostica
      // resta quella che si ricava dai fallimenti, con zero viste.
      const sightings = await db
        .prepare(
          `SELECT source_id, COUNT(*) AS n, SUM(CASE WHEN kept = 0 THEN 1 ELSE 0 END) AS scartate
           FROM sightings GROUP BY source_id`,
        )
        .all<{ source_id: string; n: number; scartate: number | null }>()
        .catch(() => ({ results: [] as { source_id: string; n: number; scartate: number | null }[] }));

      const stats: Record<string, SourceStat> = {};
      const vuoto = (): SourceStat => ({ offers: 0, lastOfferAt: null, sightings: 0, discarded: 0 });
      for (const row of items.results ?? []) {
        const stat = (stats[row.source_id] ??= vuoto());
        stat.offers = row.n;
        stat.lastOfferAt = row.ultimo;
      }
      for (const row of sightings.results ?? []) {
        const stat = (stats[row.source_id] ??= vuoto());
        stat.sightings = row.n;
        stat.discarded = row.scartate ?? 0;
      }
      return stats;
    },

    async brandCounts(): Promise<Record<string, number>> {
      // Solo concorsi: gli articoli che parlano di una marca non sono concorsi da
      // seguire, e contarli gonfierebbe il numero scritto sul bottone.
      const result = await db
        .prepare("SELECT brand, COUNT(*) AS n FROM items WHERE brand IS NOT NULL AND kind = 'contest' GROUP BY brand")
        .all<{ brand: string; n: number }>();
      const counts: Record<string, number> = {};
      for (const row of result.results ?? []) counts[row.brand] = row.n;
      return counts;
    },

    async setStatus(id: number, status: ItemStatus): Promise<void> {
      await db.prepare("UPDATE items SET status = ? WHERE id = ?").bind(status, id).run();
    },

    async touchItem(id: number, at: string): Promise<void> {
      await db.prepare("UPDATE items SET last_seen_at = ? WHERE id = ?").bind(at, id).run();
    },

    async recordSighting(sighting: Sighting): Promise<void> {
      // DO NOTHING e non DO UPDATE: la prima vista è il dato, le successive non
      // aggiungono niente e non devono spostare l'orologio del confronto.
      await db
        .prepare(
          `INSERT INTO sightings (url_key, source_id, item_id, kind, channel, seen_at, kept)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(url_key, source_id) DO NOTHING`,
        )
        .bind(
          sighting.urlKey,
          sighting.sourceId,
          sighting.itemId,
          sighting.kind,
          sighting.channel,
          sighting.seenAt,
          sighting.kept ? 1 : 0,
        )
        .run();
    },

    async listSightings(sinceIso: string, limit = 2000): Promise<Sighting[]> {
      // Tetto di sicurezza: la finestra del comando sono 30 giorni, e con questo
      // limite la schermata non può diventare una query da migliaia di righe.
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 5000);
      const result = await db
        .prepare("SELECT * FROM sightings WHERE seen_at >= ? ORDER BY seen_at DESC LIMIT ?")
        .bind(sinceIso, capped)
        .all<SightingDbRow>();
      return (result.results ?? []).map(rowToSighting);
    },

    async listItemSightings(itemId: number): Promise<Sighting[]> {
      const result = await db
        .prepare("SELECT * FROM sightings WHERE item_id = ? ORDER BY seen_at ASC")
        .bind(itemId)
        .all<SightingDbRow>();
      return (result.results ?? []).map(rowToSighting);
    },

    async deleteItems(ids: number[]): Promise<number> {
      if (ids.length === 0) return 0;
      // Ids bound, mai interpolati: la lista di placeholder è l'unica cosa che
      // si costruisce da `ids.length`.
      const placeholders = ids.map(() => "?").join(", ");
      // Prima le consegne e i rimborsi, poi l'item: nessuna riga orfana in
      // `deliveries` (che farebbe saltare una futura rispedizione dello stesso
      // concorso) né in `refunds` (che mostrerebbe un rimborso senza offerta).
      await db.prepare(`DELETE FROM deliveries WHERE item_id IN (${placeholders})`).bind(...ids).run();
      await db.prepare(`DELETE FROM refunds WHERE item_id IN (${placeholders})`).bind(...ids).run();
      const deleted = await db.prepare(`DELETE FROM items WHERE id IN (${placeholders})`).bind(...ids).run();
      return deleted.meta?.changes ?? ids.length;
    },

    async getPrefs(chatId: number): Promise<Prefs | null> {
      const row = await db.prepare("SELECT * FROM prefs WHERE chat_id = ?").bind(chatId).first<PrefsDbRow>();
      return row ? rowToPrefs(row) : null;
    },

    async upsertPrefs(prefs: Prefs): Promise<void> {
      await db
        .prepare(
          `INSERT INTO prefs (chat_id, active, weights, min_score_instant, quiet_hours, digest_hours, instant_alerts, filters, giro_hour, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             active = excluded.active,
             weights = excluded.weights,
             min_score_instant = excluded.min_score_instant,
             quiet_hours = excluded.quiet_hours,
             digest_hours = excluded.digest_hours,
             instant_alerts = excluded.instant_alerts,
             filters = excluded.filters,
             giro_hour = excluded.giro_hour,
             updated_at = excluded.updated_at`,
        )
        .bind(
          prefs.chatId,
          prefs.active ? 1 : 0,
          JSON.stringify(prefs.weights),
          prefs.minScoreInstant,
          prefs.quietHours,
          JSON.stringify(prefs.digestHours),
          prefs.instantAlerts ? 1 : 0,
          JSON.stringify(prefs.filters),
          prefs.giroHour ?? null,
          new Date().toISOString(),
        )
        .run();
    },

    async listChats(): Promise<number[]> {
      const result = await db.prepare("SELECT chat_id FROM prefs WHERE active = 1").all<{ chat_id: number }>();
      return (result.results ?? []).map((row) => row.chat_id);
    },

    async isDelivered(chatId: number, itemId: number, kind: string): Promise<boolean> {
      const row = await db
        .prepare("SELECT 1 AS hit FROM deliveries WHERE chat_id = ? AND item_id = ? AND kind = ? LIMIT 1")
        .bind(chatId, itemId, kind)
        .first<{ hit: number }>();
      return row !== null && row !== undefined;
    },

    async recordDelivery(chatId: number, itemId: number, kind: string, at: string): Promise<void> {
      await db
        .prepare(
          `INSERT INTO deliveries (chat_id, item_id, kind, sent_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(chat_id, item_id, kind) DO UPDATE SET sent_at = excluded.sent_at`,
        )
        .bind(chatId, itemId, kind, at)
        .run();
    },

    async deleteDelivery(chatId: number, itemId: number, kind: string): Promise<boolean> {
      const deleted = await db
        .prepare("DELETE FROM deliveries WHERE chat_id = ? AND item_id = ? AND kind = ?")
        .bind(chatId, itemId, kind)
        .run();
      return (deleted.meta?.changes ?? 0) > 0;
    },

    async lastDeliveryAt(chatId: number, kind: string): Promise<string | null> {
      const row = await db
        .prepare("SELECT sent_at FROM deliveries WHERE chat_id = ? AND kind = ? ORDER BY sent_at DESC LIMIT 1")
        .bind(chatId, kind)
        .first<{ sent_at: string }>();
      return row?.sent_at ?? null;
    },

    async claimRefund(chatId: number, itemId: number, amountCents: number, cap: boolean, at: string): Promise<void> {
      // DO NOTHING, non DO UPDATE: un doppio tocco su un rimborso già ricevuto
      // non deve riportarlo in attesa né riscrivere la cifra dichiarata allora.
      await db
        .prepare(
          `INSERT INTO refunds (chat_id, item_id, amount_cents, cap, claimed_at, received_at)
           VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT(chat_id, item_id) DO NOTHING`,
        )
        .bind(chatId, itemId, Math.max(0, Math.round(amountCents)), cap ? 1 : 0, at)
        .run();
    },

    async markRefundReceived(chatId: number, itemId: number, at: string): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE refunds SET received_at = ?
            WHERE chat_id = ? AND item_id = ? AND received_at IS NULL`,
        )
        .bind(at, chatId, itemId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async undoRefund(chatId: number, itemId: number): Promise<boolean> {
      const result = await db
        .prepare("DELETE FROM refunds WHERE chat_id = ? AND item_id = ?")
        .bind(chatId, itemId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async getRefund(chatId: number, itemId: number): Promise<RefundRow | null> {
      const row = await db
        .prepare(
          `SELECT i.*, r.amount_cents AS refund_amount_cents, r.cap AS refund_cap,
                  r.claimed_at AS refund_claimed_at, r.received_at AS refund_received_at
             FROM refunds r JOIN items i ON i.id = r.item_id
            WHERE r.chat_id = ? AND r.item_id = ?`,
        )
        .bind(chatId, itemId)
        .first<RefundDbRow>();
      return row ? rowToRefund(row, chatId) : null;
    },

    async listRefunds(chatId: number, limit = 200): Promise<RefundRow[]> {
      // In attesa prima ("cosa deve ancora tornare?"), poi i più recenti: è
      // l'ordine in cui si legge la schermata, e non serve riordinare in memoria.
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
      const result = await db
        .prepare(
          `SELECT i.*, r.amount_cents AS refund_amount_cents, r.cap AS refund_cap,
                  r.claimed_at AS refund_claimed_at, r.received_at AS refund_received_at
             FROM refunds r JOIN items i ON i.id = r.item_id
            WHERE r.chat_id = ?
            ORDER BY (r.received_at IS NULL) DESC, r.claimed_at DESC, r.item_id ASC
            LIMIT ?`,
        )
        .bind(chatId, capped)
        .all<RefundDbRow>();
      return (result.results ?? []).map((row) => rowToRefund(row, chatId));
    },

    async refundTotals(chatId: number): Promise<RefundTotals> {
      // Un'aggregata sola: il menù la legge a ogni schermata, e caricare le righe
      // per sommarle in JS costerebbe tanto quanto leggerle tutte.
      const row = await db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN received_at IS NULL THEN amount_cents ELSE 0 END), 0) AS pending_cents,
             COALESCE(SUM(CASE WHEN received_at IS NOT NULL THEN amount_cents ELSE 0 END), 0) AS received_cents,
             COALESCE(SUM(CASE WHEN received_at IS NULL THEN 1 ELSE 0 END), 0) AS pending,
             COALESCE(SUM(CASE WHEN received_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS received,
             COALESCE(SUM(CASE WHEN received_at IS NULL AND amount_cents = 0 THEN 1 ELSE 0 END), 0) AS unknown_pending,
             COALESCE(SUM(CASE WHEN received_at IS NOT NULL AND amount_cents = 0 THEN 1 ELSE 0 END), 0) AS unknown_received,
             COALESCE(SUM(CASE WHEN received_at IS NULL AND cap = 1 THEN 1 ELSE 0 END), 0) AS cap_pending,
             COALESCE(SUM(CASE WHEN received_at IS NOT NULL AND cap = 1 THEN 1 ELSE 0 END), 0) AS cap_received
           FROM refunds WHERE chat_id = ?`,
        )
        .bind(chatId)
        .first<{
          pending_cents: number;
          received_cents: number;
          pending: number;
          received: number;
          unknown_pending: number;
          unknown_received: number;
          cap_pending: number;
          cap_received: number;
        }>();
      return {
        pendingCents: row?.pending_cents ?? 0,
        receivedCents: row?.received_cents ?? 0,
        pending: row?.pending ?? 0,
        received: row?.received ?? 0,
        unknownPending: row?.unknown_pending ?? 0,
        unknownReceived: row?.unknown_received ?? 0,
        capPending: row?.cap_pending ?? 0,
        capReceived: row?.cap_received ?? 0,
      };
    },

    async bumpWeights(chatId: number, delta: Record<string, number>): Promise<void> {
      const row = await db.prepare("SELECT * FROM prefs WHERE chat_id = ?").bind(chatId).first<PrefsDbRow>();
      const current = row
        ? rowToPrefs(row)
        : {
            chatId,
            active: true,
            weights: {},
            minScoreInstant: 80,
            quietHours: "23-7",
            digestHours: [],
            instantAlerts: false,
            filters: defaultFilters(),
          };
      const weights: Record<string, number> = { ...current.weights };
      for (const [tag, value] of Object.entries(delta)) {
        if (!Number.isFinite(value)) continue;
        weights[tag] = Math.max(-5, Math.min(5, (weights[tag] ?? 0) + value));
      }

      await db
        .prepare(
          `INSERT INTO prefs (chat_id, active, weights, min_score_instant, quiet_hours, digest_hours, instant_alerts, filters, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET weights = excluded.weights, updated_at = excluded.updated_at`,
        )
        .bind(
          chatId,
          current.active ? 1 : 0,
          JSON.stringify(weights),
          current.minScoreInstant,
          current.quietHours,
          JSON.stringify(current.digestHours),
          current.instantAlerts ? 1 : 0,
          JSON.stringify(current.filters),
          new Date().toISOString(),
        )
        .run();
    },

    async listFlyers(): Promise<Flyer[]> {
      const result = await db.prepare("SELECT * FROM flyers ORDER BY chain").all<FlyerDbRow>();
      return (result.results ?? []).map((row) => ({
        chain: row.chain,
        url: row.url,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        coverUrl: row.cover_url,
        checkedAt: row.checked_at,
        changedAt: row.changed_at,
        status: row.status,
      }));
    },

    async saveFlyer(flyer: Flyer): Promise<void> {
      await db
        .prepare(
          `INSERT INTO flyers (chain, url, valid_from, valid_to, cover_url, checked_at, changed_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chain) DO UPDATE SET
             url = excluded.url, valid_from = excluded.valid_from, valid_to = excluded.valid_to,
             cover_url = excluded.cover_url, checked_at = excluded.checked_at,
             changed_at = excluded.changed_at, status = excluded.status`,
        )
        .bind(flyer.chain, flyer.url, flyer.validFrom, flyer.validTo, flyer.coverUrl, flyer.checkedAt, flyer.changedAt, flyer.status)
        .run();
    },

    async togglePlay(chatId: number, itemId: number, day: string, at: string): Promise<boolean> {
      const tolto = await db
        .prepare("DELETE FROM plays WHERE chat_id = ? AND day = ? AND item_id = ?")
        .bind(chatId, day, itemId)
        .run();
      if ((tolto.meta?.changes ?? 0) > 0) return false;
      await db
        .prepare("INSERT INTO plays (chat_id, day, item_id, played_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(chatId, day, itemId, at)
        .run();
      return true;
    },

    async playedOn(chatId: number, day: string): Promise<number[]> {
      const result = await db
        .prepare("SELECT item_id FROM plays WHERE chat_id = ? AND day = ?")
        .bind(chatId, day)
        .all<{ item_id: number }>();
      return (result.results ?? []).map((row) => row.item_id);
    },

    async playDays(chatId: number, sinceDay: string): Promise<string[]> {
      const result = await db
        .prepare("SELECT DISTINCT day FROM plays WHERE chat_id = ? AND day >= ? ORDER BY day DESC")
        .bind(chatId, sinceDay)
        .all<{ day: string }>();
      return (result.results ?? []).map((row) => row.day);
    },

    async addReceipt(receipt): Promise<void> {
      await db
        .prepare(
          `INSERT INTO receipts (chat_id, item_id, file_id, file_unique_id, media, added_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(receipt.chatId, receipt.itemId, receipt.fileId, receipt.fileUniqueId, receipt.media, receipt.addedAt)
        .run();
    },

    async listReceipts(chatId: number, itemId: number): Promise<ReceiptRow[]> {
      const result = await db
        .prepare("SELECT * FROM receipts WHERE chat_id = ? AND item_id = ? ORDER BY added_at ASC, id ASC")
        .bind(chatId, itemId)
        .all<ReceiptDbRow>();
      return (result.results ?? []).map(rowToReceipt);
    },

    async deleteReceipt(chatId: number, receiptId: number): Promise<boolean> {
      const result = await db
        .prepare("DELETE FROM receipts WHERE chat_id = ? AND id = ?")
        .bind(chatId, receiptId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async receiptItems(chatId: number, limit = 200): Promise<ItemRow[]> {
      const result = await db
        .prepare(
          `SELECT i.* FROM items i
             JOIN (SELECT item_id, MAX(added_at) AS ultimo FROM receipts WHERE chat_id = ? GROUP BY item_id) r
               ON r.item_id = i.id
            ORDER BY r.ultimo DESC
            LIMIT ?`,
        )
        .bind(chatId, Math.min(Math.max(Math.trunc(limit), 1), 500))
        .all<ItemDbRow>();
      return (result.results ?? []).map(rowToItem);
    },

    async getUiState(chatId: number): Promise<UiState | null> {
      const row = await db.prepare("SELECT * FROM ui WHERE chat_id = ?").bind(chatId).first<UiDbRow>();
      return row ? rowToUiState(row) : null;
    },

    async saveUiState(state: UiState): Promise<void> {
      await db
        .prepare(
          `INSERT INTO ui (chat_id, message_id, section, page, open_item_id, last_check_at, history, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             message_id = excluded.message_id,
             section = excluded.section,
             page = excluded.page,
             open_item_id = excluded.open_item_id,
             last_check_at = excluded.last_check_at,
             history = excluded.history,
             updated_at = excluded.updated_at`,
        )
        .bind(
          state.chatId,
          state.messageId,
          state.section,
          state.page,
          state.openItemId,
          state.lastCheckAt,
          JSON.stringify(state.history ?? []),
          // La colonna è NOT NULL: chi non dichiara l'ora (uno strumento, un test
          // che scrive lo stato a mano) riceve quella del salvataggio, che è
          // l'unico valore che non fa credere a una chat ferma da mesi.
          state.updatedAt ?? new Date().toISOString(),
        )
        .run();
    },

    async listDeliveredItems(chatId: number, kind: string, limit = 50): Promise<ItemRow[]> {
      // Una JOIN invece di due giri: la scheda "salvati" vuole gli item interi,
      // e chiederli per id costerebbe una query in più per ogni riga.
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
      const result = await db
        .prepare(
          `SELECT i.* FROM deliveries d
             JOIN items i ON i.id = d.item_id
            WHERE d.chat_id = ? AND d.kind = ?
            ORDER BY d.sent_at DESC
            LIMIT ?`,
        )
        .bind(chatId, kind, capped)
        .all<ItemDbRow>();
      return (result.results ?? []).map(rowToItem);
    },

    async recordRun(run: RunRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO runs (started_at, trigger, sources_ok, sources_fail, items_new, ms, note, log)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(run.startedAt, run.trigger, run.sourcesOk, run.sourcesFail, run.itemsNew, run.ms, run.note, run.log)
        .run();
    },

    async recentRuns(limit: number): Promise<RunRow[]> {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 50);
      const result = await db
        .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
        .bind(capped)
        .all<RunDbRow>();
      return (result.results ?? []).map(rowToRun);
    },

    /** L'ora dell'ultima esecuzione con quei trigger: una riga, niente scansione. */
    async lastRunAt(triggers: readonly string[]): Promise<string | null> {
      if (triggers.length === 0) return null;
      const segnaposto = triggers.map(() => "?").join(", ");
      const row = await db
        .prepare(`SELECT started_at FROM runs WHERE trigger IN (${segnaposto}) ORDER BY started_at DESC LIMIT 1`)
        .bind(...triggers)
        .first<{ started_at: string }>();
      return row?.started_at ?? null;
    },

    /**
     * I log delle ultime raccolte, dal più recente. `log IS NOT NULL` è il
     * filtro che conta: i tick da 15 minuti non hanno un racconto da dare, quindi
     * quello che resta è l'elenco dei lanci veri.
     */
    async recentLogs(limit: number): Promise<RunRow[]> {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 50);
      const result = await db
        .prepare("SELECT * FROM runs WHERE log IS NOT NULL ORDER BY started_at DESC LIMIT ?")
        .bind(capped)
        .all<RunDbRow>();
      return (result.results ?? []).map(rowToRun);
    },

    async claimUpdate(updateId: number, at: string): Promise<boolean> {
      // Pre-check: se il driver non restituisce meta.changes questo è il fallback affidabile.
      const seen = await db.prepare("SELECT 1 AS hit FROM updates WHERE update_id = ?").bind(updateId).first<{ hit: number }>();
      if (seen) return false;

      const result = await db
        .prepare("INSERT INTO updates (update_id, processed_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .bind(updateId, at)
        .run();
      const changes = (result.meta as { changes?: number } | undefined)?.changes;
      if (typeof changes === "number") return changes > 0;
      return true;
    },

    async pruneLogs(runsBefore: string, updatesBefore: string): Promise<void> {
      await db.prepare("DELETE FROM runs WHERE started_at < ?").bind(runsBefore).run();
      await db.prepare("DELETE FROM updates WHERE processed_at < ?").bind(updatesBefore).run();
    },

    async aiUsage(day: string): Promise<number> {
      const row = await db.prepare("SELECT neurons FROM ai_usage WHERE day = ?").bind(day).first<AiUsageDbRow>();
      return row?.neurons ?? 0;
    },

    async addAiUsage(day: string, calls: number, neurons: number): Promise<void> {
      await db
        .prepare(
          `INSERT INTO ai_usage (day, calls, neurons) VALUES (?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET calls = calls + excluded.calls, neurons = neurons + excluded.neurons`,
        )
        .bind(day, calls, neurons)
        .run();
    },

    async getRobots(origin: string): Promise<RobotsRow | null> {
      const row = await db.prepare("SELECT * FROM robots WHERE origin = ?").bind(origin).first<RobotsDbRow>();
      return row ? { origin: row.origin, body: row.body, fetchedAt: row.fetched_at } : null;
    },

    async saveRobots(origin: string, body: string, fetchedAt: string): Promise<void> {
      await db
        .prepare(
          `INSERT INTO robots (origin, body, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT(origin) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
        )
        .bind(origin, body, fetchedAt)
        .run();
    },
  };
}
