import type {
  ItemPatch,
  ItemQuery,
  ItemRow,
  ItemStatus,
  NewItem,
  Prefs,
  RobotsRow,
  RunRow,
  Sighting,
  SourceRow,
  UiState,
} from "../types.ts";

/**
 * Unica astrazione di persistenza usata da pipeline e layer Telegram.
 * Due implementazioni: D1 (produzione, src/db/d1.ts) e in-memory (test/dry-run,
 * src/db/memory.ts). Se aggiungi un metodo qui, aggiorna entrambe.
 */
export interface Store {
  // --- fonti ---
  getSources(): Promise<SourceRow[]>;
  recordSourceRun(
    id: string,
    result: {
      ok: boolean;
      httpStatus: number | null;
      etag: string | null;
      lastModified: string | null;
      error: string | null;
      now: string;
    },
  ): Promise<void>;

  // --- item ---
  /**
   * Candidati duplicati: urlKey identico, oppure simhash a distanza di Hamming
   * ≤ DUP_CANDIDATE_MAX_HAMMING, ordinati dal più simile.
   * È un PREFILTER: la decisione finale la prende isDuplicateTitle in src/dedupe.ts,
   * perché il solo SimHash non separa i duplicati veri dai concorsi diversi.
   */
  findDuplicateCandidates(urlKey: string, simhash: string, sinceIso: string, limit?: number): Promise<ItemRow[]>;
  /** Inserisce l'item; se urlKey esiste già restituisce la riga esistente e created=false. */
  insertItem(item: NewItem): Promise<{ item: ItemRow; created: boolean }>;
  updateItem(id: number, patch: ItemPatch): Promise<void>;
  getItem(id: number): Promise<ItemRow | null>;
  queryItems(query: ItemQuery): Promise<ItemRow[]>;
  setStatus(id: number, status: ItemStatus): Promise<void>;
  /** Somma un "anche su" senza creare un nuovo item. */
  touchItem(id: number, at: string): Promise<void>;
  /**
   * Cancella item e relative consegne per chat. Serve alla pulizia dei falsi
   * positivi (pagine di catalogo finite in archivio da una sitemap) e non ha
   * nulla a che vedere con `expireOldItems`, che invece conserva la riga.
   * Restituisce quante righe di `items` sono state davvero cancellate.
   */
  deleteItems(ids: number[]): Promise<number>;

  // --- vantaggio di tempistica ---
  /**
   * La PRIMA vista di una fonte su un concorso. Idempotente: la seconda volta
   * (stessa coppia url_key + fonte) non scrive niente, quindi la tabella non
   * cresce a ogni giro di raccolta.
   */
  recordSighting(sighting: Sighting): Promise<void>;
  /** Le viste registrate dal timestamp indicato, dalla più recente. */
  listSightings(sinceIso: string, limit?: number): Promise<Sighting[]>;
  /** Le viste di un solo concorso: serve alla riga di anticipo sulla scheda. */
  listItemSightings(itemId: number): Promise<Sighting[]>;

  // --- preferenze / consegne ---
  getPrefs(chatId: number): Promise<Prefs | null>;
  upsertPrefs(prefs: Prefs): Promise<void>;
  listChats(): Promise<number[]>;
  isDelivered(chatId: number, itemId: number, kind: string): Promise<boolean>;
  recordDelivery(chatId: number, itemId: number, kind: string, at: string): Promise<void>;
  lastDeliveryAt(chatId: number, kind: string): Promise<string | null>;
  bumpWeights(chatId: number, delta: Record<string, number>): Promise<void>;

  // --- interfaccia in chat ---
  /** Stato del messaggio unico della chat; null la prima volta. */
  getUiState(chatId: number): Promise<UiState | null>;
  /** Salva lo stato del messaggio unico (upsert su chat_id). */
  saveUiState(state: UiState): Promise<void>;
  /** Item consegnati a questa chat con quel tipo ("saved", "won", "ignored"), dal più recente. */
  listDeliveredItems(chatId: number, kind: string, limit?: number): Promise<ItemRow[]>;
  /** Numero di item che soddisfano la query, senza caricare le righe. */
  countItems(query: ItemQuery): Promise<number>;

  // --- diagnostica ---
  recordRun(run: RunRow): Promise<void>;
  recentRuns(limit: number): Promise<RunRow[]>;
  /** true la prima volta che vede l'update_id, false se è un retry Telegram. */
  claimUpdate(updateId: number, at: string): Promise<boolean>;

  // --- Workers AI ---
  aiUsage(day: string): Promise<number>;
  addAiUsage(day: string, calls: number, neurons: number): Promise<void>;

  // --- robots.txt ---
  getRobots(origin: string): Promise<RobotsRow | null>;
  saveRobots(origin: string, body: string, fetchedAt: string): Promise<void>;
}
