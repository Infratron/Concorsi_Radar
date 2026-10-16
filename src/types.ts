/** Tipi condivisi da tutti i moduli di concorsi-radar. */

export type SourceKind = "rss" | "news" | "sitemap" | "html";
export type Category = "online" | "punto_vendita" | "scontrino" | "giftcard" | "altro";
export type ItemStatus = "new" | "sent" | "saved" | "ignored" | "won" | "expired";

/** Fonte dichiarativa, come scritta in src/config/sources.ts. */
export interface SourceConfig {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  category: Category;
  tags: string[];
  /** Ogni quanti minuti ricontrollare la fonte (multiplo di 15). */
  cadenceMin: number;
  enabled: boolean;
  /**
   * Regex sul target: per kind=sitemap si applica a <loc>, per kind=html agli href.
   * Serve a tenere solo gli URL interessanti (evita di raccogliere tutto il sito).
   */
  includePattern?: string;
  /** Tetto di elementi letti per esecuzione (CPU/rumore). */
  maxItems?: number;
}

/** Fonte + stato runtime conservato in D1. */
export interface SourceRow extends SourceConfig {
  etag: string | null;
  lastModified: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  failStreak: number;
}

/** Elemento grezzo estratto da una fonte, prima di deduplica e arricchimento. */
export interface RawItem {
  sourceId: string;
  url: string;
  title: string;
  summary: string;
  /** ISO 8601 UTC oppure null. */
  publishedAt: string | null;
  guid: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Contesto passato ai parser di ingestione. */
export interface IngestContext {
  fetcher: FetchLike;
  userAgent: string;
  now: Date;
}

/** Esito dell'ingestione di una singola fonte. */
export interface SourceRunResult {
  sourceId: string;
  httpStatus: number | null;
  /** true quando la fonte ha risposto 304 (ETag/Last-Modified invariati). */
  notModified: boolean;
  /** true quando robots.txt vieta la raccolta: nessun item, nessun errore. */
  robotsDenied: boolean;
  items: RawItem[];
  etag: string | null;
  lastModified: string | null;
  error: string | null;
  /**
   * Millisecondi spesi nel parsing (solo CPU, nessuna attesa di rete).
   * Serve al freno di CPU della pipeline: su Workers Free il limite di 10 ms
   * riguarda la CPU, non il tempo di parete.
   */
  parseMs: number;
}

/** Campi estratti per capire "quanto vale" un concorso. */
export interface Insight {
  /** YYYY-MM-DD */
  deadline: string | null;
  prize: string | null;
  participation: string | null;
  /** 0..1 — valore del premio stimato. */
  prizeValue: number;
  /** 0..1 — 1 = sforzo quasi nullo. */
  effort: number;
  requiresPurchase: boolean;
  tags: string[];
  aiUsed: boolean;
}

export interface ItemRow {
  id: number;
  sourceId: string;
  url: string;
  urlKey: string;
  simhash: string;
  title: string;
  summary: string;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  deadline: string | null;
  prize: string | null;
  participation: string | null;
  prizeValue: number;
  effort: number;
  requiresPurchase: boolean;
  tags: string[];
  score: number;
  clusterId: number | null;
  status: ItemStatus;
  aiUsed: boolean;
}

/** Item pronto per l'inserimento (senza i campi generati dal database). */
export interface NewItem {
  sourceId: string;
  url: string;
  urlKey: string;
  simhash: string;
  title: string;
  summary: string;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  deadline: string | null;
  prize: string | null;
  participation: string | null;
  prizeValue: number;
  effort: number;
  requiresPurchase: boolean;
  tags: string[];
  score: number;
  clusterId: number | null;
  status: ItemStatus;
  aiUsed: boolean;
}

/** Patch parziale applicata a un item esistente (deduplica, arricchimento, stato). */
export interface ItemPatch {
  lastSeenAt?: string;
  deadline?: string | null;
  prize?: string | null;
  participation?: string | null;
  prizeValue?: number;
  effort?: number;
  requiresPurchase?: boolean;
  tags?: string[];
  score?: number;
  clusterId?: number | null;
  status?: ItemStatus;
  aiUsed?: boolean;
}

/** Query flessibile usata dai comandi Telegram e dai digest. */
export interface ItemQuery {
  /** Solo item già consegnati a questa chat? Usato per i digest. */
  since?: string;
  until?: string;
  statuses?: ItemStatus[];
  minScore?: number;
  keyword?: string;
  /** deadline <= questa data (YYYY-MM-DD). */
  deadlineBefore?: string;
  /** deadline >= questa data (YYYY-MM-DD): serve a mostrare solo le scadenze future. */
  deadlineAfter?: string;
  /** Esclude gli item i cui id compaiono qui. */
  excludeIds?: number[];
  limit?: number;
  orderBy?: "first_seen" | "score" | "deadline";
}

export interface Prefs {
  chatId: number;
  active: boolean;
  /** Pesi appresi per tag dai bottoni ✅ / 🚫. */
  weights: Record<string, number>;
  minScoreInstant: number;
  /** "23-7" = silenzio dalle 23 alle 7 (ora locale Europe/Rome). */
  quietHours: string;
  digestHours: number[];
}

/** Stato dell'interfaccia in chat: il bot tiene UN messaggio e lo modifica. */
export interface UiState {
  chatId: number;
  /** Id del messaggio da modificare; null la prima volta. */
  messageId: number | null;
  /** Sezione mostrata: "menu" | "nuovi" | "oggi" | "settimana" | "scadenze" | "salvati" | "fonti" | "impostazioni" | "cerca" | "cerca:<query>". */
  section: string;
  /** Pagina dell'elenco (0-based). */
  page: number;
  /** Item aperto in scheda sopra la sezione, null se si vede l'elenco. */
  openItemId: number | null;
  /** Da quando contare i "nuovi" (ISO 8601). */
  lastCheckAt: string | null;
}

export interface RunRow {
  startedAt: string;
  trigger: string;
  sourcesOk: number;
  sourcesFail: number;
  itemsNew: number;
  ms: number;
  note: string | null;
}

export interface RobotsRow {
  origin: string;
  body: string;
  fetchedAt: string;
}

/** Binding Workers AI (sottoinsieme usato). */
export interface AiBinding {
  run(model: string, inputs: unknown): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  AI: AiBinding;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** Chat id dell'admin: riceve gli avvisi di sistema. */
  ADMIN_CHAT_ID: string;
  /** Chat id autorizzati a usare il bot, separati da virgola (es. "111,222"). */
  ALLOWED_CHAT_IDS: string;
}
