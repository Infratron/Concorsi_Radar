/** Tipi condivisi da tutti i moduli di concorsi-radar. */

export type SourceKind = "rss" | "news" | "sitemap" | "html";
/**
 * Dove si usa quello che la fonte pubblica. `coupon` è l'unica che dice anche
 * COSA pubblica la fonte (buoni sconto e rimborsi invece di concorsi) ed è per
 * questo che la classificazione la legge: vedi src/enrich/kind.ts.
 */
export type Category = "online" | "punto_vendita" | "scontrino" | "giftcard" | "coupon" | "altro";
export type ItemStatus = "new" | "sent" | "saved" | "ignored" | "won" | "expired";
/**
 * Un concorso a premi, un'offerta da spendere (buono sconto, rimborso, cashback)
 * o un articolo/contenitore che parla di concorsi.
 *
 * Tre tipi e non due perché il coupon non sta bene né di qua né di là: non è un
 * concorso (non c'è niente da vincere, c'è da pagare meno) e non è nemmeno un
 * articolo che ne parla. Le tre sezioni della chat sono queste tre cose.
 */
export type ItemKind = "contest" | "news" | "coupon";

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
  /**
   * Come è andato l'ULTIMO tentativo, comunque sia finito: codice HTTP della
   * risposta (null se non c'è stata risposta), motivo del fallimento, item
   * grezzi letti. È la diagnostica delle fonti leggibile dalla chat e da
   * /health: prima questi dati esistevano solo nei log di GitHub.
   */
  lastStatus: number | null;
  lastError: string | null;
  lastItems: number;
}

/**
 * L'esito di UNA fonte in UN giro di raccolta: è la riga del report delle prime
 * raccolte su GitHub ("chi ha risposto, con che codice, a che ora"). Vive in
 * memoria per la durata del giro — quello che resta in archivio è lo stato
 * dell'ultimo tentativo, in `SourceRow`.
 */
export interface SourceAttempt {
  sourceId: string;
  name: string;
  /** Quando è stato fatto il tentativo (ISO 8601): è l'ora che compare nel report. */
  at: string;
  httpStatus: number | null;
  items: number;
  notModified: boolean;
  robotsDenied: boolean;
  error: string | null;
}

/**
 * Da CHI arriva la notizia, non da chi organizza il concorso. Serve a misurare il
 * vantaggio di tempistica (src/enrich/lead.ts): `brand` è la fonte diretta di cui
 * andiamo fieri, `aggregatore` è il metro con cui ci confrontiamo, `stampa` sono
 * gli echi (le query Google News) che restano fuori dal confronto.
 */
export type SourceChannel = "brand" | "aggregatore" | "stampa";

/**
 * La PRIMA volta che una fonte ha visto un concorso.
 *
 * Perché esiste: in `items` c'è una riga sola per concorso e tiene solo la fonte
 * che l'ha visto per prima — un duplicato aggiorna `last_seen_at` e non lascia
 * traccia di chi altro lo avesse. Così l'anticipo rispetto agli aggregatori era
 * impossibile da misurare: qui invece ogni fonte lascia la sua riga, e il
 * confronto si fa fra la prima vista diretta e la prima vista da aggregatore.
 *
 * La chiave è (url_key, source_id): la seconda volta che la stessa fonte rivede
 * lo stesso URL non si scrive niente, quindi la tabella non cresce a ogni giro.
 */
export interface Sighting {
  urlKey: string;
  sourceId: string;
  /** id della riga in `items`, oppure null se il cancello l'ha scartato. */
  itemId: number | null;
  kind: ItemKind;
  channel: SourceChannel;
  /** ISO 8601: quando il GIRO di raccolta l'ha visto, non la data della fonte. */
  seenAt: string;
  /** false = visto ma scartato (non è un concorso attivo). */
  kept: boolean;
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
  /**
   * La marca del concorso (Ferrero, Conad…), riconosciuta all'ingestione dalla
   * fonte o dal testo: vedi src/config/brands.ts. null = non riconosciuta, e in
   * chat è una riga in meno, non una sezione sbagliata.
   */
  brand: string | null;
  /** Concorso vero o contenitore: decide in quale sezione della chat finisce. */
  kind: ItemKind;
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
  /**
   * Il regolamento (bando) del concorso, quando non è nel testo dell'item: la
   * pipeline lo cerca nella pagina del concorso e lo salva qui
   * (src/enrich/regulation.ts). null = non trovato, e in chat è un bottone in
   * meno, mai un link inventato.
   */
  rulesUrl: string | null;
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
  /**
   * Opzionale di proposito: chi lo omette non dichiara una marca, e chi non si
   * occupa del riconoscimento (test, strumenti) resta valido.
   */
  brand?: string | null;
  /**
   * Opzionale di proposito: chi lo omette ottiene un concorso, quindi i chiamanti
   * che non si occupano di classificazione (test, strumenti) restano validi.
   */
  kind?: ItemKind;
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
  /**
   * Opzionale di proposito, come brand e kind: chi lo omette non dichiara un
   * regolamento e la riga nasce senza (la chat lo cerca nel testo dell'item).
   */
  rulesUrl?: string | null;
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
  /** La marca si scrive quando si riconosce, e non si cancella mai con null. */
  brand?: string | null;
  /**
   * Il regolamento si scrive quando si trova, e non si cancella mai con null:
   * una copia dello stesso concorso arrivata senza non deve togliere il bando
   * che la prima aveva già trovato.
   */
  rulesUrl?: string | null;
  /**
   * Titolo e simhash si aggiornano INSIEME, e solo per migliorare: lo stesso
   * concorso arriva da più fonti, e capita che una di queste lo nomini meglio
   * dell'altra (la sitemap di un sito usa lo slug, il suo feed il titolo vero).
   */
  title?: string;
  simhash?: string;
  /** Serve a riclassificare una riga già in archivio. */
  kind?: ItemKind;
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
  /** Solo item di questo tipo; senza il campo si leggono tutti. */
  kinds?: ItemKind[];
  minScore?: number;
  keyword?: string;
  /** deadline <= questa data (YYYY-MM-DD). */
  deadlineBefore?: string;
  /** deadline >= questa data (YYYY-MM-DD): serve a mostrare solo le scadenze future. */
  deadlineAfter?: string;
  /**
   * Solo item la cui validità non è finita: `deadline` assente OPPURE >= a
   * questa data (YYYY-MM-DD). È il filtro di 💶 Coupon, e la differenza con
   * `deadlineAfter` è tutta lì: quello chiede una scadenza dichiarata e lascia
   * fuori i coupon che non ne hanno (quasi tutti), questo li tiene dentro e
   * toglie solo quelli la cui validità è passata. Un concorso chiuso resta
   * leggibile nei 🏆 Vinti e in ⌛ Scaduti; un buono sconto scaduto non si può
   * più spendere, e in elenco sarebbe una riga che non serve a niente.
   */
  deadlineNotBefore?: string;
  /**
   * Solo item SENZA scadenza. Sono quelli nati da un elenco (sitemap, pagina
   * HTML): senza data di chiusura l'unico modo per sapere se sono ancora
   * concorsi attivi è il cancello di src/enrich/freshness.ts, e la pulizia ne
   * guarda solo questa fetta invece di tutto l'archivio.
   */
  withoutDeadline?: boolean;
  /**
   * Solo item SENZA regolamento salvato: è la query del riempimento
   * (scripts/backfill-rules.ts), che cerca il bando dei concorsi entrati in
   * archivio prima che la colonna esistesse.
   */
  withoutRules?: boolean;
  /** Esclude gli item i cui id compaiono qui. */
  excludeIds?: number[];
  /** Tiene fuori gli item che vengono da queste fonti (filtri della chat). */
  excludeSources?: string[];
  /** Tiene fuori gli item che hanno uno di questi tag (filtri della chat). */
  excludeTags?: string[];
  /**
   * Tiene fuori gli item di queste marche (filtri della chat). Un item senza
   * marca resta: non si può escludere quello che non si conosce, e sparire per
   * un dato mancante è peggio che mostrare una riga di troppo.
   */
  excludeBrands?: string[];
  /**
   * Solo gli item che hanno ALMENO uno di questi tag. È l'inclusione che mancava:
   * `excludeTags` spegne un tipo, questo lo chiede. Serve alle sezioni per tipo
   * di premio (🎁 Tipi di premio), dove la domanda è "che premio cerchi?" e non
   * "cosa non vuoi vedere": lì l'esclusione non basta, perché il tag acceso è
   * quello che si vuole vedere.
   */
  tags?: string[];
  /** Solo item senza obbligo di acquisto (filtro "solo gratis" della chat). */
  withoutPurchase?: boolean;
  /**
   * Solo item per cui una spesa serve (💸 Con acquisto). È il gemello di
   * `withoutPurchase`: insieme coprono le due metà dell'archivio, e la sezione
   * che le mostra è la stessa domanda girata — "quali posso fare senza
   * comprare?" e "quali chiedono di comprare?".
   */
  withPurchase?: boolean;
  /**
   * Solo gli item di queste marche ("Marche seguite"). Elenco vuoto =
   * nessun filtro, come tutti gli altri campi di questa query.
   */
  brands?: string[];
  limit?: number;
  /**
   * Salta le prime N righe. È quello che rende VERE le pagine della chat: senza,
   * l'elenco può mostrare solo le prime righe caricate, e con un archivio
   * grande la coda resta irraggiungibile.
   */
  offset?: number;
  /** "deadline_desc" = chiusi di recente per primi (serve allo storico). */
  orderBy?: "first_seen" | "score" | "deadline" | "deadline_desc";
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
  /**
   * Cosa vuole vedere QUESTA chat. Sta in `prefs` perché è una preferenza come
   * le altre: due persone sullo stesso bot hanno due feed diversi, e nessun
   * filtro è globale (vedi src/filters.ts).
   */
  filters: ChatFilters;
}

/**
 * Filtri personali di una chat: cosa mostrare e cosa no.
 * Sono tutti elenchi di ESCLUSIONI, non di inclusioni: una fonte nuova (o un
 * tag nuovo) è visibile a tutti finché qualcuno non lo spegne. Con l'elenco
 * inverso, una fonte aggiunta oggi resterebbe invisibile a chi non la conosce.
 * L'unica eccezione sono le marche seguite: aggiungono (un punteggio più alto,
 * e la sezione dei preferiti), e nascondono solo se accendi `brandsOnly`.
 */
export interface ChatFilters {
  /**
   * Le marche che questa chat segue (id di src/config/brands.ts). È l'unico
   * elenco di INCLUSIONE qui dentro, e ha una regola sua: da solo non nasconde
   * niente — i concorsi delle marche seguite si vedono come tutti gli altri e
   * valgono di più (vedi brandsOnly).
   */
  favoriteBrands: string[];
  /**
   * Le marche che questa chat non vuole più vedere. È l'esclusione che mancava
   * accanto a fonti, categorie e tipi: la marca è la granularità che si sceglie
   * guardando un concorso ("basta con questa insegna"), non una fonte intera.
   * Si accende dalla scheda del concorso, con 🔕 Mai più, e si spegne da
   * 🎛 Cosa vedi.
   */
  mutedBrands: string[];
  /**
   * true = negli elenchi resta SOLO quello che è di una marca seguita. È il
   * filtro vero, quello che nasconde: si accende a parte, perché "seguo
   * Ferrero" non vuol dire "non voglio vedere altro".
   */
  brandsOnly: boolean;
  /** Id delle fonti che questa chat non vuole vedere. */
  mutedSources: string[];
  /** Categorie di fonte spente (le categorie stanno in src/config/sources.ts). */
  mutedCategories: Category[];
  /** Tipi di concorso spenti: sono i tag degli item ("raccolta_punti", "viaggio"…). */
  mutedTags: string[];
  /** true = solo concorsi senza obbligo di acquisto. */
  freeOnly: boolean;
  /**
   * Stelle minime (0 = tutte). È il punteggio 0-100 che l'elenco mostra accanto
   * al titolo: alzandolo si tiene la testa della classifica e si lascia fuori la
   * coda. Gli elenchi sono già ordinati dal punteggio più alto, quindi il primo
   * risultato è sempre il concorso che vale di più.
   */
  minScore: number;
}

/** Stato dell'interfaccia in chat: il bot tiene UN messaggio e lo modifica. */
/** Un punto della navigazione: dove si era, per poterci tornare con ⬅️. */
export interface NavPoint {
  section: string;
  /** Pagina dell'elenco (0-based). */
  page: number;
}

export interface UiState {
  chatId: number;
  /** Id del messaggio da modificare; null la prima volta. */
  messageId: number | null;
  /** Sezione mostrata: "menu" | "nuovi" | "oggi" | "settimana" | "scadenze" | "salvati" | "fonti" | "diagnostica" | "preferiti" | "preferiti-lista" | "impostazioni" | "cerca" | "cerca:<query>". */
  section: string;
  /** Pagina dell'elenco (0-based). */
  page: number;
  /**
   * Le schermate da cui si è arrivati, dalla più vecchia alla più recente:
   * alimenta ⬅️ Indietro, che torna alla schermata precedente CON la sua pagina.
   *
   * Non è (solo) un vezzo: dalla pagina 5 di 6 di un elenco, aprire un concorso
   * ed essere riportati alla prima pagina era il modo di perdere il posto.
   * Facoltativa perché le righe scritte prima che esistesse non l'hanno.
   */
  history?: NavPoint[];
  /** Item aperto in scheda sopra la sezione, null se si vede l'elenco. */
  openItemId: number | null;
  /** Da quando contare i "nuovi" (ISO 8601). */
  lastCheckAt: string | null;
  /**
   * Quando la chat ha interagito l'ultima volta (ISO 8601), null se non si sa.
   *
   * Non è un dato di servizio: è quello che permette di capire se il messaggio
   * salvato è ANCORA quello che l'utente ha davanti. Telegram accetta la modifica
   * di un messaggio che l'utente non vede più (dopo "Elimina conversazione"
   * risponde ok), quindi l'unico modo per non scrivere nel vuoto è non fidarsi di
   * un messaggio vecchio: vedi isStaleChat in src/telegram/bot.ts.
   */
  updatedAt: string | null;
}

export interface RunRow {
  startedAt: string;
  trigger: string;
  sourcesOk: number;
  sourcesFail: number;
  itemsNew: number;
  ms: number;
  note: string | null;
  /**
   * Il racconto fonte per fonte di una raccolta — chi ha risposto, con che
   * codice HTTP, quanti item — in HTML, come lo compone src/telegram/report.ts.
   *
   * Lo scrivono le raccolte vere (Actions, un PC, la raccolta di riserva del
   * Worker); i tick da 15 minuti e i digest lasciano `null`. Quindi l'elenco dei
   * log È l'elenco dei lanci, e si legge in 🧾 Log delle raccolte, la schermata
   * che vede solo l'admin.
   */
  log: string | null;
}

export interface RobotsRow {
  origin: string;
  body: string;
  fetchedAt: string;
}

/**
 * Un rimborso (o cashback) che QUESTA chat ha chiesto indietro.
 *
 * Una riga per coppia chat+offerta: chiedere due volte lo stesso rimborso non
 * raddoppia niente. `amountCents` a 0 vuol dire "il bando non dichiara una
 * cifra fissa" (una percentuale, un 1+1): il totale del denaro non lo conta, e
 * la chat lo dice invece di far finta che sia zero.
 */
export interface RefundRow {
  chatId: number;
  itemId: number;
  /** L'offerta a cui si riferisce, intera: la scheda e l'elenco la mostrano. */
  item: ItemRow;
  amountCents: number;
  /** true = la cifra è un tetto ("fino a 100 €"), non l'importo esatto. */
  cap: boolean;
  claimedAt: string;
  /** null finché il denaro non è tornato davvero. */
  receivedAt: string | null;
}

/** I quattro numeri della schermata 💰 Rimborsi, e del bottone nel menù. */
export interface RefundTotals {
  pendingCents: number;
  receivedCents: number;
  pending: number;
  received: number;
  /** Richieste senza cifra fissa, ancora in attesa: non entrano in pendingCents. */
  unknownPending: number;
  /** Richieste senza cifra fissa, già ricevute: non entrano in receivedCents. */
  unknownReceived: number;
  /**
   * Richieste il cui importo è un tetto ("fino a 100 €"), ancora in attesa.
   * Sono GIÀ dentro pendingCents: il totale è il massimo che può tornare, e la
   * chat lo dice ("fino a") invece di spacciarlo per la cifra esatta.
   */
  capPending: number;
  /** Richieste con tetto già ricevute: stesso discorso per receivedCents. */
  capReceived: number;
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
  /**
   * Token GitHub (fine-grained, permesso Actions: write) per svegliare la
   * raccolta quando il cron tace: vedi src/collect/dispatch.ts. Facoltativo: se
   * manca, il Worker si limita alla raccolta di riserva.
   */
  GITHUB_DISPATCH_TOKEN?: string;
  /** "owner/repo" del repository dove gira la raccolta (`[vars]` di wrangler.toml). */
  GITHUB_REPO?: string;
  /** File del workflow da svegliare (default ingest.yml). */
  GITHUB_WORKFLOW?: string;
  /** Ramo su cui farlo partire (default main). */
  GITHUB_REF?: string;
}
