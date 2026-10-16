-- Schema D1 di concorsi-radar.
-- Applicare con: npm run db:init  (oppure db:init:local per i test in locale)

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL,
  category      TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  cadence_min   INTEGER NOT NULL DEFAULT 15,
  enabled       INTEGER NOT NULL DEFAULT 1,
  etag          TEXT,
  last_modified TEXT,
  last_run_at   TEXT,
  last_ok_at    TEXT,
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  last_status   INTEGER,
  last_error    TEXT,
  last_items    INTEGER NOT NULL DEFAULT 0
);

-- `last_status`, `last_error` e `last_items` raccontano l'ULTIMO tentativo su
-- quella fonte (codice HTTP, motivo del fallimento, item grezzi letti): sono la
-- diagnostica delle prime raccolte — "chi ha risposto e chi no" — leggibile
-- dalla chat e da /health, senza aprire i log di GitHub. Su un database già
-- creato le colonne vanno aggiunte a mano PRIMA di pubblicare il codice che le
-- legge e le scrive:
--   ALTER TABLE sources ADD COLUMN last_status INTEGER;
--   ALTER TABLE sources ADD COLUMN last_error TEXT;
--   ALTER TABLE sources ADD COLUMN last_items INTEGER NOT NULL DEFAULT 0;

-- `kind` distingue i concorsi veri dagli articoli e dalle pagine-contenitore che
-- ne parlano: nello stesso archivio convivono i due, e la chat li mostra in
-- sezioni diverse. Su un database già creato la colonna va aggiunta a mano:
--   ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'contest';
--
-- `brand` è la marca del concorso (id di src/config/brands.ts), riconosciuta
-- all'ingestione dalla fonte o dal testo: è quello che rende possibile la
-- sezione "Preferiti per marca" e il filtro "solo le marche che seguo". Su un
-- database già creato la colonna va aggiunta a mano, e le righe già in archivio
-- si riempiono con `npm run brands -- --apply`:
--   ALTER TABLE items ADD COLUMN brand TEXT;
--   CREATE INDEX IF NOT EXISTS idx_items_brand ON items (brand);
--
-- `kind` vale 'contest' (concorso), 'coupon' (buono sconto, rimborso, cashback)
-- oppure 'news' (articolo o pagina-contenitore). Il terzo valore non richiede
-- nessuna migrazione: la colonna è TEXT e il default resta 'contest', che è il
-- valore giusto per un archivio nato prima dei coupon.
--
-- `rules_url` è il regolamento (bando) del concorso quando NON è nel testo
-- dell'item: la pipeline lo cerca nella pagina del concorso e lo salva qui, così
-- in chat il bottone 📄 Regolamento c'è anche quando il testo non lo nomina
-- (src/enrich/regulation.ts). Su un database già creato la colonna va aggiunta a
-- mano, e le righe già in archivio (i concorsi raccolti prima) si riempiono con
-- `npm run rules -- --apply`:
--   ALTER TABLE items ADD COLUMN rules_url TEXT;
CREATE TABLE IF NOT EXISTS items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id         TEXT NOT NULL,
  brand             TEXT,
  kind              TEXT NOT NULL DEFAULT 'contest',
  url               TEXT NOT NULL,
  url_key           TEXT NOT NULL UNIQUE,
  simhash           TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL DEFAULT '',
  published_at      TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  deadline          TEXT,
  prize             TEXT,
  participation     TEXT,
  rules_url         TEXT,
  prize_value       REAL NOT NULL DEFAULT 0,
  effort            REAL NOT NULL DEFAULT 0.5,
  requires_purchase INTEGER NOT NULL DEFAULT 0,
  tags              TEXT NOT NULL DEFAULT '[]',
  score             INTEGER NOT NULL DEFAULT 0,
  cluster_id        INTEGER,
  status            TEXT NOT NULL DEFAULT 'new',
  ai_used           INTEGER NOT NULL DEFAULT 0
);

-- Le sezioni della chat leggono "gli item degli ultimi N giorni": l'indice
-- composto serve proprio a quella coppia di filtri (un indice sul solo kind, con
-- tre valori possibili, non aiuterebbe).
CREATE INDEX IF NOT EXISTS idx_items_kind_seen  ON items (kind, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_first_seen ON items (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_deadline   ON items (deadline);
CREATE INDEX IF NOT EXISTS idx_items_status     ON items (status);
CREATE INDEX IF NOT EXISTS idx_items_score      ON items (score DESC);
-- Le due letture della sezione preferiti: "i concorsi di questa marca" (filtro
-- sull'elenco) e "quanti ne ha ogni marca" (il conteggio dei bottoni).
CREATE INDEX IF NOT EXISTS idx_items_brand      ON items (brand);

-- `sightings`: la prima volta che ogni fonte ha visto un concorso. È la memoria
-- che serve al vantaggio di tempistica (comando /vantaggio): in `items` resta solo
-- la fonte che l'ha visto per prima, quindi senza questa tabella non si può sapere
-- se l'aggregatore è arrivato dopo di noi o prima.
--
-- La chiave (url_key, source_id) rende la scrittura idempotente: si scrive una
-- volta per concorso e per fonte, e i giri successivi non aggiungono righe.
-- È una misura, non un dato di servizio: la pipeline registra la vista in un blocco
-- che non può far fallire l'ingestione, quindi una tabella mancante costa il
-- numero, non il concorso. Va creata PRIMA di pubblicare il codice che la usa:
--   npm run db:init   (CREATE TABLE IF NOT EXISTS: non tocca le altre tabelle)
CREATE TABLE IF NOT EXISTS sightings (
  url_key   TEXT NOT NULL,
  source_id TEXT NOT NULL,
  item_id   INTEGER,
  kind      TEXT NOT NULL DEFAULT 'contest',
  channel   TEXT NOT NULL,
  seen_at   TEXT NOT NULL,
  kept      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (url_key, source_id)
);

-- La finestra del comando è "gli ultimi 30 giorni di viste": l'indice serve a
-- non leggere tutta la tabella ogni volta che si apre la schermata.
CREATE INDEX IF NOT EXISTS idx_sightings_seen ON sightings (seen_at DESC);
-- La scheda di un concorso chiede le sue viste: senza indice è una scansione.
CREATE INDEX IF NOT EXISTS idx_sightings_item ON sightings (item_id);
-- La diagnostica delle fonti conta le viste PER FONTE (sourceStats in
-- src/db/store.ts) e quante di quelle sono state scartate: non è una finestra di
-- tempo, quindi non usa idx_sightings_seen. Con questo indice il conteggio si
-- legge per indice invece che riga per riga ("kept" sta nell'indice perché è la
-- seconda cosa che si conta).
CREATE INDEX IF NOT EXISTS idx_sightings_source ON sightings (source_id, kept);

CREATE TABLE IF NOT EXISTS deliveries (
  chat_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, item_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_sent ON deliveries (chat_id, sent_at DESC);

-- `filters` sono i filtri personali della chat (fonti, categorie e tipi di
-- concorso spenti, più "solo senza acquisto"): JSON, uno per chat, così due
-- persone sullo stesso bot vedono due feed diversi. Su un database già creato la
-- colonna va aggiunta a mano PRIMA di pubblicare il codice che la usa:
--   ALTER TABLE prefs ADD COLUMN filters TEXT NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS prefs (
  chat_id           INTEGER PRIMARY KEY,
  active            INTEGER NOT NULL DEFAULT 1,
  weights           TEXT NOT NULL DEFAULT '{}',
  min_score_instant INTEGER NOT NULL DEFAULT 80,
  quiet_hours       TEXT NOT NULL DEFAULT '23-7',
  digest_hours      TEXT NOT NULL DEFAULT '[8,19]',
  filters           TEXT NOT NULL DEFAULT '{}',
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  sources_ok   INTEGER NOT NULL DEFAULT 0,
  sources_fail INTEGER NOT NULL DEFAULT 0,
  items_new    INTEGER NOT NULL DEFAULT 0,
  ms           INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  log          TEXT
);

-- `log` è il racconto fonte per fonte di UNA raccolta (chi ha risposto, con che
-- codice HTTP, quanti item): la stessa cosa che il job su GitHub scrive nella
-- pagina di riepilogo, ma leggibile dalla chat in 🧾 Log delle raccolte — la
-- schermata che vede solo l'admin. Lo scrivono le raccolte vere (`actions`,
-- `local` e la raccolta di riserva del Worker); i tick da 15 minuti e i digest
-- lasciano NULL, quindi l'elenco dei log è l'elenco dei lanci. Su un database
-- già creato la colonna va aggiunta a mano PRIMA di pubblicare il codice che la
-- legge:
--   ALTER TABLE runs ADD COLUMN log TEXT;

-- Idempotenza del webhook Telegram: Telegram ritenta gli update non-2xx.
CREATE TABLE IF NOT EXISTS updates (
  update_id    INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL
);

-- Tetto giornaliero Workers AI (10.000 Neurons/giorno sul piano Free).
CREATE TABLE IF NOT EXISTS ai_usage (
  day     TEXT PRIMARY KEY,
  calls   INTEGER NOT NULL DEFAULT 0,
  neurons INTEGER NOT NULL DEFAULT 0
);

-- Cache di robots.txt per origine.
CREATE TABLE IF NOT EXISTS robots (
  origin     TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Stato dell'interfaccia in chat: il bot tiene UN messaggio per chat e lo modifica
-- (menù, sezioni, schede), invece di accumulare messaggi.
CREATE TABLE IF NOT EXISTS ui (
  chat_id       INTEGER PRIMARY KEY,
  message_id    INTEGER,
  section       TEXT NOT NULL DEFAULT 'menu',
  page          INTEGER NOT NULL DEFAULT 0,
  open_item_id  INTEGER,
  last_check_at TEXT,
  updated_at    TEXT NOT NULL
);
