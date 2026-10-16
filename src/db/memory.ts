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
import { defaultFilters } from "../filters.ts";

/**
 * Store in-memory: stessa semantica di D1, senza database.
 * Serve ai test e al dry-run da Node (scripts/dry-run.ts).
 */

export interface MemoryStore extends Store {
  /** Inietta le fonti: altrimenti getSources() è vuoto. */
  seedSources(sources: SourceRow[]): void;
}

interface DeliveryRow {
  chatId: number;
  itemId: number;
  kind: string;
  sentAt: string;
}

const DEFAULT_DIGEST_HOURS = [8, 19];

function defaultPrefs(chatId: number): Prefs {
  return {
    chatId,
    active: true,
    weights: {},
    minScoreInstant: 80,
    quietHours: "23-7",
    digestHours: [...DEFAULT_DIGEST_HOURS],
    filters: defaultFilters(),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clampWeight(value: number): number {
  return Math.max(-5, Math.min(5, value));
}

export function createMemoryStore(): MemoryStore {
  const sources = new Map<string, SourceRow>();
  const items: ItemRow[] = [];
  const deliveries: DeliveryRow[] = [];
  const prefs = new Map<number, Prefs>();
  const runs: RunRow[] = [];
  const updates = new Set<number>();
  const aiUsage = new Map<string, { calls: number; neurons: number }>();
  const robots = new Map<string, RobotsRow>();
  const ui = new Map<number, UiState>();
  let nextItemId = 1;

  const applyPatch = (row: ItemRow, patch: ItemPatch): void => {
    if (patch.lastSeenAt !== undefined) row.lastSeenAt = patch.lastSeenAt;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.simhash !== undefined) row.simhash = patch.simhash;
    if (patch.kind !== undefined) row.kind = patch.kind;
    if (patch.deadline !== undefined) row.deadline = patch.deadline;
    if (patch.prize !== undefined) row.prize = patch.prize;
    if (patch.participation !== undefined) row.participation = patch.participation;
    if (patch.prizeValue !== undefined) row.prizeValue = patch.prizeValue;
    if (patch.effort !== undefined) row.effort = patch.effort;
    if (patch.requiresPurchase !== undefined) row.requiresPurchase = patch.requiresPurchase;
    if (patch.tags !== undefined) row.tags = [...patch.tags];
    if (patch.score !== undefined) row.score = patch.score;
    if (patch.clusterId !== undefined) row.clusterId = patch.clusterId;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.aiUsed !== undefined) row.aiUsed = patch.aiUsed;
  };

  const matchesQuery = (row: ItemRow, query: ItemQuery): boolean => {
    if (query.since && row.firstSeenAt < query.since) return false;
    if (query.until && row.firstSeenAt > query.until) return false;
    if (query.statuses && query.statuses.length > 0 && !query.statuses.includes(row.status)) return false;
    if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(row.kind)) return false;
    if (typeof query.minScore === "number" && row.score < query.minScore) return false;
    const keyword = query.keyword?.trim().toLowerCase();
    if (keyword) {
      const haystack = `${row.title} ${row.summary}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    if (query.withoutDeadline === true && row.deadline !== null) return false;
    if (query.deadlineBefore) {
      if (row.deadline === null || row.deadline > query.deadlineBefore) return false;
    }
    if (query.deadlineAfter) {
      if (row.deadline === null || row.deadline < query.deadlineAfter) return false;
    }
    if (query.excludeIds && query.excludeIds.length > 0 && query.excludeIds.includes(row.id)) return false;
    if (query.excludeSources && query.excludeSources.includes(row.sourceId)) return false;
    if (query.excludeTags && query.excludeTags.length > 0 && row.tags.some((tag) => query.excludeTags!.includes(tag))) {
      return false;
    }
    if (query.withoutPurchase === true && row.requiresPurchase) return false;
    return true;
  };

  // L'ultimo criterio è sempre l'id decrescente, come in SQL: senza, due righe a
  // pari punteggio possono cambiare ordine fra una query e l'altra e le pagine
  // della chat salterebbero o ripeterebbero un concorso.
  const compare = (orderBy: ItemQuery["orderBy"], a: ItemRow, b: ItemRow): number => {
    if (orderBy === "score") {
      return b.score - a.score || b.firstSeenAt.localeCompare(a.firstSeenAt) || b.id - a.id;
    }
    if (orderBy === "deadline") {
      // NULL in fondo, come in SQL (deadline IS NULL ASC).
      const left = a.deadline ?? "9999-12-31";
      const right = b.deadline ?? "9999-12-31";
      return left.localeCompare(right) || b.score - a.score || b.id - a.id;
    }
    if (orderBy === "deadline_desc") {
      if (a.deadline === null && b.deadline === null) return b.id - a.id;
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return b.deadline.localeCompare(a.deadline) || b.id - a.id;
    }
    return b.firstSeenAt.localeCompare(a.firstSeenAt) || b.id - a.id;
  };

  return {
    seedSources(list: SourceRow[]): void {
      for (const source of list) sources.set(source.id, clone(source));
    },

    async getSources(): Promise<SourceRow[]> {
      return [...sources.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((source) => clone(source));
    },

    async recordSourceRun(id, result): Promise<void> {
      const source = sources.get(id);
      if (!source) return;
      if (result.etag !== null) source.etag = result.etag;
      if (result.lastModified !== null) source.lastModified = result.lastModified;
      source.lastRunAt = result.now;
      if (result.ok) {
        source.failStreak = 0;
        source.lastOkAt = result.now;
      } else {
        source.failStreak += 1;
      }
    },

    async findDuplicateCandidates(key, simhashValue, sinceIso, limit = 8): Promise<ItemRow[]> {
      const byKey = items.find((row) => row.urlKey === key);
      if (byKey) return [clone(byKey)];

      const candidates = items
        .filter((row) => row.firstSeenAt >= sinceIso)
        .sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))
        .slice(0, 300);
      return candidates
        .map((row) => ({ row, distance: hammingHex(row.simhash, simhashValue) }))
        .filter((entry) => entry.distance <= DUP_CANDIDATE_MAX_HAMMING)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, Math.max(1, limit))
        .map((entry) => clone(entry.row));
    },

    async insertItem(item: NewItem): Promise<{ item: ItemRow; created: boolean }> {
      const existing = items.find((row) => row.urlKey === item.urlKey);
      if (existing) return { item: clone(existing), created: false };

      // `kind` esplicito: chi non lo passa sta inserendo un concorso (è il caso
      // dei test e degli strumenti che non si occupano di classificazione).
      const row: ItemRow = { id: nextItemId++, ...clone(item), kind: item.kind ?? "contest" };
      items.push(row);
      return { item: clone(row), created: true };
    },

    async updateItem(id: number, patch: ItemPatch): Promise<void> {
      const row = items.find((candidate) => candidate.id === id);
      if (!row) return;
      applyPatch(row, patch);
    },

    async getItem(id: number): Promise<ItemRow | null> {
      const row = items.find((candidate) => candidate.id === id);
      return row ? clone(row) : null;
    },

    async queryItems(query: ItemQuery): Promise<ItemRow[]> {
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), 200);
      const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
      return items
        .filter((row) => matchesQuery(row, query))
        .sort((a, b) => compare(query.orderBy, a, b))
        .slice(offset, offset + limit)
        .map((row) => clone(row));
    },

    async countItems(query: ItemQuery): Promise<number> {
      return items.filter((row) => matchesQuery(row, query)).length;
    },

    async setStatus(id: number, status: ItemStatus): Promise<void> {
      const row = items.find((candidate) => candidate.id === id);
      if (row) row.status = status;
    },

    async touchItem(id: number, at: string): Promise<void> {
      const row = items.find((candidate) => candidate.id === id);
      if (row) row.lastSeenAt = at;
    },

    async deleteItems(ids: number[]): Promise<number> {
      if (ids.length === 0) return 0;
      const targets = new Set(ids);
      // Prima le consegne, poi l'item: stessa promessa dell'implementazione D1.
      for (let index = deliveries.length - 1; index >= 0; index--) {
        if (targets.has(deliveries[index].itemId)) deliveries.splice(index, 1);
      }
      let removed = 0;
      for (let index = items.length - 1; index >= 0; index--) {
        if (targets.has(items[index].id)) {
          items.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },

    async getPrefs(chatId: number): Promise<Prefs | null> {
      const value = prefs.get(chatId);
      return value ? clone(value) : null;
    },

    async upsertPrefs(value: Prefs): Promise<void> {
      prefs.set(value.chatId, clone(value));
    },

    async listChats(): Promise<number[]> {
      return [...prefs.values()]
        .filter((value) => value.active)
        .map((value) => value.chatId)
        .sort((a, b) => a - b);
    },

    async isDelivered(chatId: number, itemId: number, kind: string): Promise<boolean> {
      return deliveries.some(
        (row) => row.chatId === chatId && row.itemId === itemId && row.kind === kind,
      );
    },

    async recordDelivery(chatId: number, itemId: number, kind: string, at: string): Promise<void> {
      const existing = deliveries.find(
        (row) => row.chatId === chatId && row.itemId === itemId && row.kind === kind,
      );
      if (existing) existing.sentAt = at;
      else deliveries.push({ chatId, itemId, kind, sentAt: at });
    },

    async lastDeliveryAt(chatId: number, kind: string): Promise<string | null> {
      const matching = deliveries
        .filter((row) => row.chatId === chatId && row.kind === kind)
        .map((row) => row.sentAt)
        .sort();
      return matching.length > 0 ? matching[matching.length - 1] : null;
    },

    async bumpWeights(chatId: number, delta: Record<string, number>): Promise<void> {
      const current = prefs.get(chatId) ?? defaultPrefs(chatId);
      const weights: Record<string, number> = { ...current.weights };
      for (const [tag, value] of Object.entries(delta)) {
        if (!Number.isFinite(value)) continue;
        weights[tag] = clampWeight((weights[tag] ?? 0) + value);
      }
      prefs.set(chatId, { ...current, weights });
    },

    async getUiState(chatId: number): Promise<UiState | null> {
      const value = ui.get(chatId);
      return value ? clone(value) : null;
    },

    async saveUiState(state: UiState): Promise<void> {
      ui.set(state.chatId, clone(state));
    },

    async listDeliveredItems(chatId: number, kind: string, limit = 50): Promise<ItemRow[]> {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
      return deliveries
        .filter((row) => row.chatId === chatId && row.kind === kind)
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .slice(0, capped)
        .map((row) => items.find((item) => item.id === row.itemId))
        .filter((item): item is ItemRow => item !== undefined)
        .map((item) => clone(item));
    },

    async recordRun(run: RunRow): Promise<void> {
      runs.push(clone(run));
    },

    async recentRuns(limit: number): Promise<RunRow[]> {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 50);
      return runs
        .slice()
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, capped)
        .map((run) => clone(run));
    },

    async claimUpdate(updateId: number, _at: string): Promise<boolean> {
      if (updates.has(updateId)) return false;
      updates.add(updateId);
      return true;
    },

    async aiUsage(day: string): Promise<number> {
      return aiUsage.get(day)?.neurons ?? 0;
    },

    async addAiUsage(day: string, calls: number, neurons: number): Promise<void> {
      const current = aiUsage.get(day) ?? { calls: 0, neurons: 0 };
      aiUsage.set(day, { calls: current.calls + calls, neurons: current.neurons + neurons });
    },

    async getRobots(origin: string): Promise<RobotsRow | null> {
      const value = robots.get(origin);
      return value ? clone(value) : null;
    },

    async saveRobots(origin: string, body: string, fetchedAt: string): Promise<void> {
      robots.set(origin, { origin, body, fetchedAt });
    },
  };
}
