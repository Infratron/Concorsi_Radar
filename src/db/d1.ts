import type { Store } from "./store.ts";
import type {
  ItemPatch,
  ItemQuery,
  ItemRow,
  ItemStatus,
  NewItem,
  Prefs,
  RobotsRow,
  RunRow,
  SourceRow,
  UiState,
} from "../types.ts";
import { DUP_CANDIDATE_MAX_HAMMING, hammingHex } from "../lib/text.ts";

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
  etag: string | null;
  last_modified: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  fail_streak: number;
}

interface PrefsDbRow {
  chat_id: number;
  active: number;
  weights: string;
  min_score_instant: number;
  quiet_hours: string;
  digest_hours: string;
}

interface UiDbRow {
  chat_id: number;
  message_id: number | null;
  section: string;
  page: number;
  open_item_id: number | null;
  last_check_at: string | null;
}

interface RunDbRow {
  started_at: string;
  trigger: string;
  sources_ok: number;
  sources_fail: number;
  items_new: number;
  ms: number;
  note: string | null;
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

function rowToItem(row: ItemDbRow): ItemRow {
  return {
    id: row.id,
    sourceId: row.source_id,
    // Un valore inatteso non deve mai arrivare all'interfaccia: resta un concorso.
    kind: row.kind === "news" ? "news" : "contest",
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
    etag: row.etag,
    lastModified: row.last_modified,
    lastRunAt: row.last_run_at,
    lastOkAt: row.last_ok_at,
    failStreak: row.fail_streak,
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
  };
}

function rowToUiState(row: UiDbRow): UiState {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    section: row.section,
    page: row.page,
    openItemId: row.open_item_id,
    lastCheckAt: row.last_check_at,
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
  };
}

/** Colonne di items, nell'ordine usato dagli INSERT. */
const ITEM_COLUMNS = [
  "source_id", "kind", "url", "url_key", "simhash", "title", "summary", "published_at",
  "first_seen_at", "last_seen_at", "deadline", "prize", "participation", "prize_value",
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
    where.push("(LOWER(title) LIKE ? OR LOWER(summary) LIKE ?)");
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (query.withoutDeadline === true) {
    where.push("deadline IS NULL");
  }
  if (query.deadlineBefore) {
    where.push("deadline IS NOT NULL AND deadline <= ?");
    params.push(query.deadlineBefore);
  }
  if (query.deadlineAfter) {
    where.push("deadline IS NOT NULL AND deadline >= ?");
    params.push(query.deadlineAfter);
  }
  if (query.excludeIds && query.excludeIds.length > 0) {
    where.push(`id NOT IN (${query.excludeIds.map(() => "?").join(", ")})`);
    params.push(...query.excludeIds);
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
                  last_ok_at = CASE WHEN ? = 1 THEN ? ELSE last_ok_at END
            WHERE id = ?`,
        )
        .bind(
          result.etag,
          result.lastModified,
          result.now,
          result.ok ? 1 : 0,
          result.ok ? 1 : 0,
          result.now,
          id,
        )
        .run();
    },

    async findDuplicateCandidates(key, simhashValue, sinceIso, limit = 8): Promise<ItemRow[]> {
      const byKey = await db.prepare("SELECT * FROM items WHERE url_key = ?").bind(key).first<ItemDbRow>();
      if (byKey) return [rowToItem(byKey)];

      const candidates = await db
        .prepare("SELECT * FROM items WHERE first_seen_at >= ? ORDER BY first_seen_at DESC LIMIT 300")
        .bind(sinceIso)
        .all<ItemDbRow>();
      return (candidates.results ?? [])
        .map((row) => ({ row, distance: hammingHex(row.simhash, simhashValue) }))
        .filter((entry) => entry.distance <= DUP_CANDIDATE_MAX_HAMMING)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, Math.max(1, limit))
        .map((entry) => rowToItem(entry.row));
    },

    async insertItem(item: NewItem): Promise<{ item: ItemRow; created: boolean }> {
      const placeholders = ITEM_COLUMNS.map(() => "?").join(", ");
      const values: unknown[] = [
        item.sourceId, item.kind ?? "contest", item.url, item.urlKey, item.simhash, item.title, item.summary,
        item.publishedAt, item.firstSeenAt, item.lastSeenAt, item.deadline, item.prize,
        item.participation, item.prizeValue, item.effort, item.requiresPurchase ? 1 : 0,
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
      if (patch.title !== undefined) push("title", patch.title);
      if (patch.simhash !== undefined) push("simhash", patch.simhash);
      if (patch.kind !== undefined) push("kind", patch.kind);
      if (patch.deadline !== undefined) push("deadline", patch.deadline);
      if (patch.prize !== undefined) push("prize", patch.prize);
      if (patch.participation !== undefined) push("participation", patch.participation);
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

    async setStatus(id: number, status: ItemStatus): Promise<void> {
      await db.prepare("UPDATE items SET status = ? WHERE id = ?").bind(status, id).run();
    },

    async touchItem(id: number, at: string): Promise<void> {
      await db.prepare("UPDATE items SET last_seen_at = ? WHERE id = ?").bind(at, id).run();
    },

    async deleteItems(ids: number[]): Promise<number> {
      if (ids.length === 0) return 0;
      // Ids bound, mai interpolati: la lista di placeholder è l'unica cosa che
      // si costruisce da `ids.length`.
      const placeholders = ids.map(() => "?").join(", ");
      // Prima le consegne, poi l'item: nessuna riga orfana in `deliveries` che
      // farebbe saltare una futura rispedizione dello stesso concorso.
      await db.prepare(`DELETE FROM deliveries WHERE item_id IN (${placeholders})`).bind(...ids).run();
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
          `INSERT INTO prefs (chat_id, active, weights, min_score_instant, quiet_hours, digest_hours, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             active = excluded.active,
             weights = excluded.weights,
             min_score_instant = excluded.min_score_instant,
             quiet_hours = excluded.quiet_hours,
             digest_hours = excluded.digest_hours,
             updated_at = excluded.updated_at`,
        )
        .bind(
          prefs.chatId,
          prefs.active ? 1 : 0,
          JSON.stringify(prefs.weights),
          prefs.minScoreInstant,
          prefs.quietHours,
          JSON.stringify(prefs.digestHours),
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

    async lastDeliveryAt(chatId: number, kind: string): Promise<string | null> {
      const row = await db
        .prepare("SELECT sent_at FROM deliveries WHERE chat_id = ? AND kind = ? ORDER BY sent_at DESC LIMIT 1")
        .bind(chatId, kind)
        .first<{ sent_at: string }>();
      return row?.sent_at ?? null;
    },

    async bumpWeights(chatId: number, delta: Record<string, number>): Promise<void> {
      const row = await db.prepare("SELECT * FROM prefs WHERE chat_id = ?").bind(chatId).first<PrefsDbRow>();
      const current = row
        ? rowToPrefs(row)
        : { chatId, active: true, weights: {}, minScoreInstant: 80, quietHours: "23-7", digestHours: [8, 19] };
      const weights: Record<string, number> = { ...current.weights };
      for (const [tag, value] of Object.entries(delta)) {
        if (!Number.isFinite(value)) continue;
        weights[tag] = Math.max(-5, Math.min(5, (weights[tag] ?? 0) + value));
      }

      await db
        .prepare(
          `INSERT INTO prefs (chat_id, active, weights, min_score_instant, quiet_hours, digest_hours, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET weights = excluded.weights, updated_at = excluded.updated_at`,
        )
        .bind(
          chatId,
          current.active ? 1 : 0,
          JSON.stringify(weights),
          current.minScoreInstant,
          current.quietHours,
          JSON.stringify(current.digestHours),
          new Date().toISOString(),
        )
        .run();
    },

    async getUiState(chatId: number): Promise<UiState | null> {
      const row = await db.prepare("SELECT * FROM ui WHERE chat_id = ?").bind(chatId).first<UiDbRow>();
      return row ? rowToUiState(row) : null;
    },

    async saveUiState(state: UiState): Promise<void> {
      await db
        .prepare(
          `INSERT INTO ui (chat_id, message_id, section, page, open_item_id, last_check_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             message_id = excluded.message_id,
             section = excluded.section,
             page = excluded.page,
             open_item_id = excluded.open_item_id,
             last_check_at = excluded.last_check_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          state.chatId,
          state.messageId,
          state.section,
          state.page,
          state.openItemId,
          state.lastCheckAt,
          new Date().toISOString(),
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
          `INSERT INTO runs (started_at, trigger, sources_ok, sources_fail, items_new, ms, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(run.startedAt, run.trigger, run.sourcesOk, run.sourcesFail, run.itemsNew, run.ms, run.note)
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
