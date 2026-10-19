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
  include_pattern TEXT,
  max_items     INTEGER,
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

-- `include_pattern` e `max_items` dicono COME si legge una fonte (quali URL di
-- una sitemap tenere, quanti item al massimo per giro). Stanno qui e non solo in
-- src/config/sources.ts perché la raccolta gira su GitHub Actions, che parte dal
-- repository: una modifica al pattern non pubblicata non arriverebbe mai al
-- runner, mentre i valori seminati in D1 arrivano con `npm run db:sync`. Caso
-- vero del 17/10/2026: due sitemap nuove lette senza pattern hanno scartato 40
-- pagine su 40, e la configurazione sembrava giusta perché lo era — nel working
-- tree, non nel commit che il runner eseguiva. Su un database creato prima:
--   ALTER TABLE sources ADD COLUMN include_pattern TEXT;
--   ALTER TABLE sources ADD COLUMN max_items INTEGER;
--
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

-- `refunds`: i rimborsi e i cashback che ogni chat ha chiesto indietro, e se il
-- denaro è già tornato. Una riga per coppia chat+offerta: la stessa offerta può
-- essere richiesta da due persone, e chiederla due volte non raddoppia niente.
--
-- `amount_cents` è quello che il bando dichiara (0 = nessuna cifra fissa: è una
-- percentuale o un 1+1, e la chat chiede quanto è tornato davvero). `cap` dice
-- che la cifra è un tetto ("fino a 100 €"), non l'importo esatto. Le due colonne
-- insieme sono quello che rende il totale onesto: il denaro in attesa somma solo
-- le cifre dichiarate, e i rimborsi senza cifra si contano a parte.
--
-- Su un database già creato la tabella va creata PRIMA di pubblicare il codice
-- che la legge (la crea `npm run db:init`, è un CREATE TABLE IF NOT EXISTS):
CREATE TABLE IF NOT EXISTS refunds (
  chat_id      INTEGER NOT NULL,
  item_id      INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  cap          INTEGER NOT NULL DEFAULT 0,
  claimed_at   TEXT NOT NULL,
  received_at  TEXT,
  PRIMARY KEY (chat_id, item_id)
);

-- La schermata legge le richieste di una chat distinguendo attese e ricevute:
-- l'indice serve proprio a quella coppia, senza scorrere tutta la tabella.
CREATE INDEX IF NOT EXISTS idx_refunds_chat ON refunds (chat_id, received_at, claimed_at DESC);

-- `filters` sono i filtri personali della chat (fonti, categorie e tipi di
-- concorso spenti, più "solo senza acquisto"): JSON, uno per chat, così due
-- persone sullo stesso bot vedono due feed diversi. Su un database già creato la
-- colonna va aggiunta a mano PRIMA di pubblicare il codice che la usa:
--   ALTER TABLE prefs ADD COLUMN filters TEXT NOT NULL DEFAULT '{}';
--
-- `digest_hours` parte VUOTO: il riepilogo periodico non è un default, è una
-- scelta. Prima nasceva con '[8,19]' e ogni chat riceveva due riepiloghi al
-- giorno senza averli mai chiesti. Una riga vuota = digest spenti (vedi
-- sendDigests), e la scelta si fa in ⚙️ Impostazioni con la griglia delle ore.
--
-- `instant_alerts` è lo stesso discorso per gli avvisi "sopra il punteggio":
-- 0 = spenti, e restano le marche seguite, che sono una richiesta esplicita.
-- Su un database già creato la colonna va aggiunta a mano PRIMA di pubblicare il
-- codice che la legge:
--   ALTER TABLE prefs ADD COLUMN instant_alerts INTEGER NOT NULL DEFAULT 0;
-- `giro_hour` è l'ora del promemoria del 🎯 giro di oggi: NULL = spento, che è
-- il default. Si accende dalla schermata del giro.
CREATE TABLE IF NOT EXISTS prefs (
  chat_id           INTEGER PRIMARY KEY,
  active            INTEGER NOT NULL DEFAULT 1,
  weights           TEXT NOT NULL DEFAULT '{}',
  min_score_instant INTEGER NOT NULL DEFAULT 80,
  quiet_hours       TEXT NOT NULL DEFAULT '23-7',
  digest_hours      TEXT NOT NULL DEFAULT '[]',
  instant_alerts    INTEGER NOT NULL DEFAULT 0,
  filters           TEXT NOT NULL DEFAULT '{}',
  giro_hour         INTEGER,
  updated_at        TEXT NOT NULL
);

-- `plays`: i concorsi del 🎯 giro di oggi segnati ✅ Giocato. Una riga per chat,
-- giorno (italiano, YYYY-MM-DD) e concorso: il giorno nella chiave è quello che
-- fa ripartire il giro a mezzanotte senza cancellare niente, e la serie di
-- giorni di fila si legge da qui.
CREATE TABLE IF NOT EXISTS plays (
  chat_id   INTEGER NOT NULL,
  day       TEXT NOT NULL,
  item_id   INTEGER NOT NULL,
  played_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, day, item_id)
);

-- `flyers`: il volantino in corso di ogni insegna della provincia di Lecce, una
-- riga per catena (src/volantini.ts). Link e date li scrive la raccolta su
-- GitHub, che rilegge le pagine ogni dodici ore; `changed_at` è quando link o
-- date sono cambiati, cioè il "nuovo volantino".
CREATE TABLE IF NOT EXISTS flyers (
  chain       TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  valid_from  TEXT,
  valid_to    TEXT,
  cover_url   TEXT,
  checked_at  TEXT NOT NULL,
  changed_at  TEXT,
  status      INTEGER
);

-- `receipts`: gli scontrini mandati in chat, legati al concorso. Il file resta
-- su Telegram (`file_id`); `file_unique_id` impedisce di salvare due volte la
-- stessa foto per lo stesso concorso.
CREATE TABLE IF NOT EXISTS receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        INTEGER NOT NULL,
  item_id        INTEGER NOT NULL,
  file_id        TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  media          TEXT NOT NULL DEFAULT 'photo',
  added_at       TEXT NOT NULL,
  UNIQUE (chat_id, item_id, file_unique_id)
);
CREATE INDEX IF NOT EXISTS idx_receipts_chat ON receipts (chat_id, added_at DESC);

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

-- Ogni tick legge "le ultime 50 esecuzioni" e ogni schermata del menù l'ora
-- dell'ultima raccolta: senza indice sono scansioni della tabella intera, che
-- cresce di circa 150 righe al giorno (misurato il 18/10/2026: 64.238 righe
-- lette in 142 letture). Il tick toglie le righe più vecchie di 30 giorni.
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

-- `log` è il racconto fonte per fonte di UNA raccolta (chi ha risposto, con che
-- codice HTTP, quanti item): la stessa cosa che il job su GitHub scrive nella
-- pagina di riepilogo, ma leggibile dalla chat in 🧾 Log delle raccolte — la
-- schermata che vede solo l'admin. Lo scrivono le raccolte vere (`actions`,
-- `local` e la raccolta di riserva del Worker); i tick da 15 minuti e i digest
-- lasciano NULL, quindi l'elenco dei log è l'elenco dei lanci. Su un database
-- già creato la colonna va aggiunta a mano PRIMA di pubblicare il codice che la
-- legge:
--   ALTER TABLE runs ADD COLUMN log TEXT;

-- `migrations`: i passi di DATI già eseguiti (non di schema). Serve a fare una
-- volta sola una modifica alle righe esistenti — per esempio svuotare i
-- `digest_hours` che le righe vecchie avevano ereditato dal default — senza
-- ripeterla a ogni deploy e senza sovrascrivere le scelte fatte dopo. Il passo e
-- la sua chiave stanno in src/db/upgrade.ts.
CREATE TABLE IF NOT EXISTS migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Idempotenza del webhook Telegram: Telegram ritenta gli update non-2xx.
CREATE TABLE IF NOT EXISTS updates (
  update_id    INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL
);
-- Telegram ritenta per qualche ora al massimo: il tick toglie gli id più
-- vecchi di 3 giorni, e questo indice gli evita di scorrere la tabella.
CREATE INDEX IF NOT EXISTS idx_updates_processed ON updates (processed_at);

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
  -- La storia della navigazione (JSON), per ⬅️ Indietro. Serve al ritorno alla
  -- schermata precedente con la sua pagina: senza, da una pagina 5 di 6 si torna
  -- alla prima. Null per le righe scritte prima che esistesse.
  history       TEXT,
  updated_at    TEXT NOT NULL
);
