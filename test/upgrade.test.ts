import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Like, D1LikeStatement } from "../src/db/d1.ts";
import { colonneAttese, statementsFromSchema, upgradeDatabase } from "../src/db/upgrade.ts";
import { sourceSeedStatements } from "../src/db/seeds.ts";

/**
 * L'allineamento del database, sul SQL vero (node:sqlite) e sullo schema vero
 * (`src/db/schema.sql`).
 *
 * Perché vale la pena: questo comando gira da solo a ogni push (workflow
 * `Database`) e tocca il database di produzione. I due modi di sbagliare sono
 * opposti e ugualmente silenziosi: non aggiungere una colonna che serve (e ogni
 * scrittura fallisce) oppure rieseguire un ALTER che c'è già (e il workflow è
 * rosso a ogni push). Qui si provano tutti e due, più il caso che nessuno prova
 * mai finché non capita: un database VECCHIO, dove gli indici dello schema
 * citano colonne che ancora non esistono.
 */

/** `node:sqlite` a runtime: Vite toglierebbe il prefisso `node:`. */
const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const SCHEMA = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");

function sqliteBinding(db: DatabaseSync): D1Like {
  const statement = (sql: string, params: unknown[]): D1LikeStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() =>
      ((db.prepare(sql).get(...(params as SQLInputValue[])) as unknown as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...(params as SQLInputValue[])) as unknown as T[] }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql, []) };
}

function freshDb() {
  const db = new Sqlite(":memory:");
  return { db, binding: sqliteBinding(db) };
}

function nomi(tipo: "table" | "index", db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(tipo) as { name: string }[]).map(
    (riga) => riga.name,
  );
}

function colonneDi(db: DatabaseSync, tabella: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info('${tabella}')`).all() as { name: string }[]).map(
    (riga) => riga.name,
  );
}

describe("allineamento del database", () => {
  let db: DatabaseSync;
  let binding: D1Like;

  beforeEach(() => {
    ({ db, binding } = freshDb());
  });

  it("porta un database vuoto allo schema, e la seconda volta non cambia niente", async () => {
    const primo = await upgradeDatabase(binding, SCHEMA);

    expect(nomi("table", db)).toEqual(
      expect.arrayContaining([
        "ai_usage", "deliveries", "items", "prefs", "robots", "runs", "sightings", "sources", "ui", "updates",
      ]),
    );
    // Su un database vuoto le tabelle nascono già complete: niente da alterare.
    expect(primo.colonne).toEqual([]);
    expect(primo.istruzioni).toBeGreaterThan(10);

    // Il punto del comando: si può rieseguire. Niente "table already exists",
    // niente "duplicate column name", e nessun indice raccontato due volte.
    const secondo = await upgradeDatabase(binding, SCHEMA);
    expect(secondo.colonne).toEqual([]);
    expect(secondo.indici).toEqual([]);
  });

  it("su un database vecchio aggiunge solo le colonne mancanti, senza perdere righe", async () => {
    // Un archivio dell'inizio: `items` senza kind/brand/rules_url, `runs` senza log.
    db.exec(`CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, url TEXT NOT NULL,
      url_key TEXT NOT NULL UNIQUE, simhash TEXT NOT NULL, title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      deadline TEXT, prize TEXT, participation TEXT, prize_value REAL NOT NULL DEFAULT 0,
      effort REAL NOT NULL DEFAULT 0.5, requires_purchase INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]', score INTEGER NOT NULL DEFAULT 0, cluster_id INTEGER,
      status TEXT NOT NULL DEFAULT 'new', ai_used INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`INSERT INTO items (source_id, url, url_key, simhash, title, first_seen_at, last_seen_at)
             VALUES ('premieconcorsi', 'https://esempio.it/1', 'k1', 'h1', 'Concorso vecchio', '2026-01-01', '2026-01-01')`);
    db.exec(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, trigger TEXT NOT NULL,
      sources_ok INTEGER NOT NULL DEFAULT 0, sources_fail INTEGER NOT NULL DEFAULT 0,
      items_new INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, note TEXT
    )`);
    db.exec("INSERT INTO runs (started_at, trigger) VALUES ('2026-01-01T00:00:00.000Z', 'local')");

    const risultato = await upgradeDatabase(binding, SCHEMA);

    // Le colonne che il codice legge e che la tabella non aveva.
    expect(risultato.colonne).toEqual(
      expect.arrayContaining(["items.kind", "items.brand", "items.rules_url", "runs.log"]),
    );
    // `sources` non esisteva: nasce già completa, quindi non compare fra le aggiunte.
    expect(risultato.colonne).not.toContain("sources.last_status");

    // L'ordine tabelle → colonne → indici: gli indici di schema.sql citano
    // `items (kind, first_seen_at)`, che un attimo prima non esisteva.
    expect(nomi("index", db)).toEqual(expect.arrayContaining(["idx_items_kind_seen", "idx_items_brand"]));

    // Nessuna riga persa, e il default della colonna nuova è quello giusto: un
    // concorso vecchio resta un concorso, non diventa un coupon o un articolo.
    const riga = db.prepare("SELECT title, kind, brand FROM items").get() as { title: string; kind: string; brand: string | null };
    expect(riga.title).toBe("Concorso vecchio");
    expect(riga.kind).toBe("contest");
    expect(riga.brand).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
  });

  it("aggiunge ui.history a una tabella ui che esiste già, senza perdere lo stato", async () => {
    // Il caso vero della produzione: la tabella `ui` c'è da mesi, la colonna no.
    db.exec(`CREATE TABLE ui (
      chat_id INTEGER PRIMARY KEY, message_id INTEGER, section TEXT NOT NULL DEFAULT 'menu',
      page INTEGER NOT NULL DEFAULT 0, open_item_id INTEGER, last_check_at TEXT, updated_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO ui (chat_id, message_id, section, page, updated_at)
             VALUES (7, 55, 'settimana', 4, '2026-10-17T09:00:00.000Z')`);

    const risultato = await upgradeDatabase(binding, SCHEMA);

    expect(risultato.colonne).toContain("ui.history");
    // La riga resta quella: `null` = "non lo so", che è quello che le due
    // implementazioni dello Store leggono come storia assente.
    const riga = db.prepare("SELECT chat_id, section, page, history FROM ui").get() as Record<string, unknown>;
    expect(riga).toMatchObject({ chat_id: 7, section: "settimana", page: 4, history: null });
  });

  it("la semina delle fonti aggiorna la definizione e lascia lo stato runtime", async () => {
    await upgradeDatabase(binding, SCHEMA);
    db.exec(`INSERT INTO sources (id, name, kind, url, category, tags, cadence_min, enabled, etag, fail_streak, last_ok_at)
             VALUES ('premieconcorsi', 'Nome vecchio', 'rss', 'https://esempio.it/rss', 'online', '[]', 30, 1, '"abc"', 3, '2026-01-01T00:00:00.000Z')`);

    const [sql] = sourceSeedStatements([
      {
        id: "premieconcorsi",
        name: "Nome nuovo",
        kind: "rss",
        url: "https://esempio.it/rss",
        category: "online",
        tags: ["giftcard"],
        cadenceMin: 45,
        enabled: false,
      },
    ]);
    db.prepare(sql).run();

    const riga = db
      .prepare("SELECT name, cadence_min, enabled, tags, etag, fail_streak, last_ok_at FROM sources WHERE id = 'premieconcorsi'")
      .get() as Record<string, unknown>;
    // La configurazione vince.
    expect(riga.name).toBe("Nome nuovo");
    expect(riga.cadence_min).toBe(45);
    expect(riga.enabled).toBe(0);
    expect(riga.tags).toBe('["giftcard"]');
    // La storia no: senza questa parte, ogni push azzererebbe la diagnostica
    // delle fonti e il prossimo giro ripartirebbe da zero (etag compreso).
    expect(riga.etag).toBe('"abc"');
    expect(riga.fail_streak).toBe(3);
    expect(riga.last_ok_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("spezza lo schema in istruzioni, senza i commenti", () => {
    const sql = ["-- un commento", "CREATE TABLE a (x TEXT);", "", "-- un altro", "CREATE INDEX i ON a (x);"].join("\n");
    expect(statementsFromSchema(sql)).toEqual(["CREATE TABLE a (x TEXT)", "CREATE INDEX i ON a (x)"]);
  });

  it("ogni colonna attesa dice a cosa serve", () => {
    const elenco = colonneAttese();
    expect(elenco.map((voce) => voce.colonna)).toEqual(
      expect.arrayContaining(["items.kind", "items.brand", "runs.log", "prefs.filters", "ui.history"]),
    );
    expect(elenco.every((voce) => voce.perche.length > 10)).toBe(true);
  });
});
