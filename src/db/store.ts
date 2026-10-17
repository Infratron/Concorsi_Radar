import type {
  ItemPatch,
  ItemQuery,
  ItemRow,
  ItemStatus,
  NewItem,
  Prefs,
  RefundRow,
  RefundTotals,
  RobotsRow,
  RunRow,
  Sighting,
  SourceRow,
  UiState,
} from "../types.ts";

/**
 * Quanto ha reso UNA fonte all'archivio. È il dato della diagnostica delle fonti
 * (src/sources-health.ts): non "quanti item ha letto", ma che cosa è rimasto in
 * archivio grazie a lei, e quanto ha visto senza che servisse.
 *
 * Due misure diverse di proposito:
 *  - **offerte** = gli item arrivati per primi da lei, cioè quello di cui si può
 *    fare qualcosa: un concorso, o un coupon/rimborso per le fonti `coupon`.
 *    Gli articoli non contano — un pezzo che parla di concorsi non è un
 *    contributo, e contarlo direbbe che una fonte di cronaca "porta concorsi".
 *  - **viste** = ogni concorso visto, anche se era già entrato da un'altra, e
 *    quante di quelle il cancello di freschezza le ha buttate. Le viste restano
 *    dei CONCORSI: /vantaggio misura l'anticipo su quello su cui si partecipa.
 */
export interface SourceStat {
  /** Concorsi e coupon arrivati per primi da questa fonte (items.source_id). */
  offers: number;
  /** Quando è arrivata l'ultima offerta (ISO 8601); null se nessuna. */
  lastOfferAt: string | null;
  /**
   * Viste registrate: ogni concorso che questa fonte ha visto, anche se in
   * archivio era già entrato da un'altra. Una fonte con molte viste e poche
   * offerte ripete quello che hanno già gli altri.
   */
  sightings: number;
  /** Di quelle viste, quante non sono passate il cancello di freschezza. */
  discarded: number;
}

/**
 * Unica astrazione di persistenza usata da pipeline e layer Telegram.
 * Due implementazioni: D1 (produzione, src/db/d1.ts) e in-memory (test/dry-run,
 * src/db/memory.ts). Se aggiungi un metodo qui, aggiorna entrambe.
 */
export interface Store {
  // --- fonti ---
  getSources(): Promise<SourceRow[]>;
  /**
   * Registra l'esito di un tentativo su una fonte. `ok` muove i contatori della
   * storia (fail_streak, last_ok_at); `httpStatus`, `error` e `items` descrivono
   * l'ULTIMO tentativo comunque sia finito, ed è quello che si legge dalla chat.
   */
  recordSourceRun(
    id: string,
    result: {
      ok: boolean;
      httpStatus: number | null;
      etag: string | null;
      lastModified: string | null;
      error: string | null;
      /** Item grezzi letti in questo tentativo (0 se non è cambiata o è saltata). */
      items: number;
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
  /**
   * Cancella una decisione (⭐ salvato, 🚫 ignorato, 🏆 vinto) per questa chat.
   * Restituisce true se c'era davvero qualcosa: chi chiama usa la risposta per
   * non annullare due volte lo stesso effetto (i pesi dei gusti).
   */
  deleteDelivery(chatId: number, itemId: number, kind: string): Promise<boolean>;
  lastDeliveryAt(chatId: number, kind: string): Promise<string | null>;
  bumpWeights(chatId: number, delta: Record<string, number>): Promise<void>;

  // --- rimborsi richiesti (per chat) ---
  /**
   * Registra che questa chat ha chiesto indietro il rimborso di un'offerta.
   * Idempotente: la seconda volta non tocca né la cifra né lo stato, così un
   * doppio tocco (o un messaggio vecchio) non riporta in attesa un rimborso già
   * ricevuto.
   */
  claimRefund(chatId: number, itemId: number, amountCents: number, cap: boolean, at: string): Promise<void>;
  /**
   * Segna il rimborso come ricevuto. Restituisce false se non c'era niente da
   * segnare (nessuna richiesta, o già ricevuto): la chat lo dice invece di
   * fingere che sia andata.
   */
  markRefundReceived(chatId: number, itemId: number, at: string): Promise<boolean>;
  /** Cancella la richiesta di questa chat: torna come se non l'avesse mai fatta. */
  undoRefund(chatId: number, itemId: number): Promise<boolean>;
  /** La richiesta di questa chat per quell'offerta, o null. */
  getRefund(chatId: number, itemId: number): Promise<RefundRow | null>;
  /**
   * Le richieste di questa chat, quelle in attesa per prime e poi le più
   * recenti: è l'ordine in cui si guardano ("cosa deve ancora tornare?" prima
   * di "cosa è già tornato?").
   */
  listRefunds(chatId: number, limit?: number): Promise<RefundRow[]>;
  /** Il denaro in attesa e quello già recuperato, senza caricare le righe. */
  refundTotals(chatId: number): Promise<RefundTotals>;

  // --- interfaccia in chat ---
  /** Stato del messaggio unico della chat; null la prima volta. */
  getUiState(chatId: number): Promise<UiState | null>;
  /** Salva lo stato del messaggio unico (upsert su chat_id). */
  saveUiState(state: UiState): Promise<void>;
  /** Item consegnati a questa chat con quel tipo ("saved", "won", "ignored"), dal più recente. */
  listDeliveredItems(chatId: number, kind: string, limit?: number): Promise<ItemRow[]>;
  /** Numero di item che soddisfano la query, senza caricare le righe. */
  countItems(query: ItemQuery): Promise<number>;
  /**
   * Quanti concorsi ci sono per ogni marca (id del registro → conteggio). È
   * quello che ordina la schermata ⭐ Marche seguite: le marche presenti in
   * archivio stanno in cima, quelle che non hanno niente in fondo.
   */
  brandCounts(): Promise<Record<string, number>>;
  /**
   * Il contributo di ogni fonte, per id. Le fonti che non hanno mai portato
   * niente non compaiono: chi legge usa SourceStat vuoto (vedi fonteStat in
   * src/sources-health.ts).
   */
  sourceStats(): Promise<Record<string, SourceStat>>;

  // --- diagnostica ---
  recordRun(run: RunRow): Promise<void>;
  recentRuns(limit: number): Promise<RunRow[]>;
  /**
   * Quando è partita l'ultima esecuzione con uno di questi trigger (ISO 8601),
   * o null se non ce n'è nessuna. È la domanda "il radar è vivo?" nella forma
   * più corta: una riga sola, indicizzata su started_at, e il trigger lo sceglie
   * chi chiama (`EXTERNAL_TRIGGERS` per la raccolta vera, che i tick del Worker
   * non sono).
   */
  lastRunAt(triggers: readonly string[]): Promise<string | null>;
  /**
   * Le ultime esecuzioni CHE HANNO UN LOG, dalla più recente: sono le raccolte
   * vere (Actions, un PC, la raccolta di riserva del Worker). I tick da 15 minuti
   * e i digest restano fuori, perché non hanno niente da raccontare fonte per
   * fonte. È quello che legge 🧾 Log delle raccolte.
   */
  recentLogs(limit: number): Promise<RunRow[]>;
  /** true la prima volta che vede l'update_id, false se è un retry Telegram. */
  claimUpdate(updateId: number, at: string): Promise<boolean>;

  // --- Workers AI ---
  aiUsage(day: string): Promise<number>;
  addAiUsage(day: string, calls: number, neurons: number): Promise<void>;

  // --- robots.txt ---
  getRobots(origin: string): Promise<RobotsRow | null>;
  saveRobots(origin: string, body: string, fetchedAt: string): Promise<void>;
}
