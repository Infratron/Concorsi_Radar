import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Store, type D1Like, type D1LikeStatement } from "../src/db/d1.ts";
import { DUP_CANDIDATE_MAX_HAMMING, hammingHex, simhash } from "../src/lib/text.ts";
import { defaultFilters, filtersFor } from "../src/filters.ts";
import type { NewItem } from "../src/types.ts";

/**
 * Store D1 eseguito su SQLite vero (node:sqlite) con lo schema di produzione.
 * È l'unico modo per verificare l'SQL senza Cloudflare: query, ON CONFLICT,
 * RETURNING e il conteggio dei changes per l'idempotenza del webhook.
 * Il binding è finto, la sintassi no.
 */

/**
 * `node:sqlite` va caricato a runtime: Vite toglierebbe il prefisso `node:` e
 * cercherebbe un pacchetto chiamato `sqlite`, che non esiste (il modulo compare
 * in `builtinModules` solo con il prefisso).
 */
const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function sqliteBinding(db: DatabaseSync): D1Like {
  const statement = (sql: string, params: unknown[]): D1LikeStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    // I parametri arrivano come unknown dal contratto D1Like, ma lo store passa
    // solo primitivi (o null): è lo stesso confine che attraversano su D1.
    first: async <T>() => ((db.prepare(sql).get(...(params as SQLInputValue[])) as unknown as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...(params as SQLInputValue[])) as unknown as T[] }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql, []) };
}

function freshStore() {
  const db = new Sqlite(":memory:");
  db.exec(readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
  return { db, store: createD1Store(sqliteBinding(db)) };
}

function item(overrides: Partial<NewItem> = {}): NewItem {
  const title = overrides.title ?? "Concorso Esselunga buoni spesa 1000 euro";
  return {
    sourceId: "premieconcorsi",
    url: "https://www.premieconcorsi.com/concorsi/esselunga/",
    urlKey: "key-esselunga",
    simhash: simhash(title),
    title,
    summary: "Partecipa con lo scontrino.",
    publishedAt: null,
    firstSeenAt: "2026-10-16T08:00:00.000Z",
    lastSeenAt: "2026-10-16T08:00:00.000Z",
    deadline: "2026-11-30",
    prize: "10 buoni spesa da 100 euro",
    participation: "scontrino",
    prizeValue: 1000,
    effort: 0.4,
    requiresPurchase: true,
    tags: ["buoni_spesa"],
    score: 70,
    clusterId: null,
    status: "new",
    aiUsed: false,
    ...overrides,
  };
}

describe("store D1 · SQL vero su SQLite", () => {
  let store: ReturnType<typeof freshStore>["store"];

  beforeEach(() => {
    store = freshStore().store;
  });

  it("inserisce una volta sola sullo stesso urlKey e conserva i campi", async () => {
    const first = await store.insertItem(item());
    expect(first.created).toBe(true);
    expect(first.item.id).toBe(1);
    expect(first.item.requiresPurchase).toBe(true);
    expect(first.item.tags).toEqual(["buoni_spesa"]);
    expect(first.item.deadline).toBe("2026-11-30");

    const second = await store.insertItem(item({ url: "https://altro.example/x", title: "Altro titolo" }));
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(1);
    expect(second.item.title).toBe("Concorso Esselunga buoni spesa 1000 euro");
  });

  it("il tipo viene dal default della colonna, e il filtro lo usa in SQL", async () => {
    const concorso = await store.insertItem(item());
    const articolo = await store.insertItem(
      item({
        url: "https://esempio.it/articolo",
        urlKey: "key-articolo",
        title: "Migliori concorsi di ottobre",
        kind: "news",
      }),
    );
    expect(concorso.item.kind).toBe("contest");
    expect(articolo.item.kind).toBe("news");

    expect((await store.queryItems({ kinds: ["news"] })).map((row) => row.id)).toEqual([articolo.item.id]);
    expect((await store.queryItems({ kinds: ["contest"] })).map((row) => row.id)).toEqual([concorso.item.id]);
    expect(await store.countItems({ kinds: ["news"] })).toBe(1);
    expect((await store.queryItems({ kinds: [] }))).toHaveLength(2);
  });

  it("una patch può riclassificare una riga già in archivio", async () => {
    await store.insertItem(item());
    await store.updateItem(1, { kind: "news" });
    expect((await store.getItem(1))?.kind).toBe("news");
    expect((await store.queryItems({ kinds: ["contest"] }))).toHaveLength(0);
  });

  it("propone il candidato con urlKey identico", async () => {
    await store.insertItem(item());
    const candidates = await store.findDuplicateCandidates("key-esselunga", "ffffffffffffffff", "2026-10-01T00:00:00.000Z");
    expect(candidates.map((row) => row.id)).toEqual([1]);
  });

  it("propone i candidati ordinati per distanza, senza decidere lui", async () => {
    const vicino = "Concorso Esselunga buoni spesa 1000 euro con scontrino scadenza";
    await store.insertItem(item({ title: vicino, urlKey: "key-vicino", simhash: simhash(vicino) }));
    const lontano = "Concorso automobilistico per una crociera alle Bahamas";
    await store.insertItem(item({ title: lontano, urlKey: "key-lontano", simhash: simhash(lontano) }));

    const sonda = "Concorso Esselunga buoni spesa 1000 euro con scontrino";
    const distanzaVicino = hammingHex(simhash(sonda), simhash(vicino));
    const distanzaLontano = hammingHex(simhash(sonda), simhash(lontano));
    expect(distanzaVicino).toBeLessThanOrEqual(DUP_CANDIDATE_MAX_HAMMING);
    expect(distanzaVicino).toBeLessThan(distanzaLontano);

    const candidates = await store.findDuplicateCandidates("key-nuovo", simhash(sonda), "2026-10-01T00:00:00.000Z");
    // Prefilter largo di proposito: scarta solo i titoli davvero distanti e
    // mette per primo il più vicino. La decisione finale è di isDuplicateTitle.
    expect(candidates[0].urlKey).toBe("key-vicino");
    expect(candidates.map((row) => row.urlKey)).not.toContain("key-nuovo");
  });

  it("filtra, cerca e ordina nella query degli item", async () => {
    await store.insertItem(item({ urlKey: "k1", title: "Vinci buoni spesa Esselunga", score: 90, deadline: "2026-10-20" }));
    await store.insertItem(item({ urlKey: "k2", title: "Vinci un viaggio in Sardegna", score: 30, deadline: null }));
    await store.insertItem(
      item({ urlKey: "k3", title: "Concorso caffè Illy", score: 60, deadline: "2026-12-01", status: "saved" }),
    );

    expect((await store.queryItems({ statuses: ["saved"] })).map((row) => row.urlKey)).toEqual(["k3"]);
    expect((await store.queryItems({ minScore: 60, orderBy: "score" })).map((row) => row.urlKey)).toEqual(["k1", "k3"]);
    expect((await store.queryItems({ keyword: "sardegna" })).map((row) => row.urlKey)).toEqual(["k2"]);
    expect((await store.queryItems({ deadlineBefore: "2026-11-01" })).map((row) => row.urlKey)).toEqual(["k1"]);
    expect((await store.queryItems({ excludeIds: [1, 3] })).map((row) => row.urlKey)).toEqual(["k2"]);
    // deadline NULL in fondo, come l'implementazione in memoria.
    expect((await store.queryItems({ orderBy: "deadline" })).map((row) => row.urlKey)).toEqual(["k1", "k3", "k2"]);
    expect(await store.queryItems({ limit: 0 })).toHaveLength(1);
  });

  it("pagina con LIMIT e OFFSET, e ordina i chiusi dal più recente", async () => {
    // Pari punteggio e stessa data: senza l'id come ultimo criterio due pagine
    // possono sovrapporsi.
    for (let index = 1; index <= 5; index++) {
      await store.insertItem(
        item({ urlKey: `pag-${index}`, url: `https://esempio.it/pag-${index}`, title: `Concorso pagina ${index}`, score: 50 }),
      );
    }
    await store.insertItem(
      item({ urlKey: "chiuso-prima", title: "Chiuso prima", score: 20, deadline: "2026-09-01", firstSeenAt: "2026-09-01T08:00:00.000Z" }),
    );
    await store.insertItem(
      item({ urlKey: "chiuso-dopo", title: "Chiuso dopo", score: 10, deadline: "2026-10-15", firstSeenAt: "2026-10-15T08:00:00.000Z" }),
    );

    const prima = await store.queryItems({ orderBy: "score", limit: 3 });
    const seconda = await store.queryItems({ orderBy: "score", limit: 3, offset: 3 });
    expect(prima.map((row) => row.id)).toEqual([5, 4, 3]);
    // Tutte con lo stesso punteggio: la seconda pagina non ripete la prima, e
    // dietro ai pari punteggio arrivano i due concorsi già chiusi.
    expect(seconda.map((row) => row.id)).toEqual([2, 1, 6]);

    // Storico: prima chi ha chiuso per ultimo, e chi non ha una scadenza non entra.
    const chiusi = await store.queryItems({ deadlineBefore: "2026-10-16", orderBy: "deadline_desc" });
    expect(chiusi.map((row) => row.urlKey)).toEqual(["chiuso-dopo", "chiuso-prima"]);
  });

  it("aggiorna i campi indicati senza toccare gli altri", async () => {
    await store.insertItem(item({ deadline: null, prize: null, participation: null }));
    await store.updateItem(1, { deadline: "2026-12-15", tags: ["viaggio"], score: 88, aiUsed: true });

    const row = await store.getItem(1);
    expect(row?.deadline).toBe("2026-12-15");
    expect(row?.tags).toEqual(["viaggio"]);
    expect(row?.score).toBe(88);
    expect(row?.aiUsed).toBe(true);
    expect(row?.prize).toBeNull();

    await store.touchItem(1, "2026-10-20T10:00:00.000Z");
    expect((await store.getItem(1))?.lastSeenAt).toBe("2026-10-20T10:00:00.000Z");

    await store.setStatus(1, "saved");
    expect((await store.getItem(1))?.status).toBe("saved");
  });

  it("cancella item e consegne collegate, senza toccare le altre righe", async () => {
    const { db, store: s } = freshStore();
    await s.insertItem(item({ urlKey: "k1" }));
    await s.insertItem(item({ urlKey: "k2", url: "https://b.example/secondo" }));
    await s.recordDelivery(111, 1, "saved", "2026-10-16T09:00:00.000Z");
    await s.recordDelivery(111, 2, "digest", "2026-10-16T09:00:00.000Z");

    expect(await s.deleteItems([1])).toBe(1);
    expect(await s.getItem(1)).toBeNull();
    expect(await s.isDelivered(111, 1, "saved")).toBe(false);
    expect((await s.queryItems({ limit: 10 })).map((row) => row.id)).toEqual([2]);

    // Nessuna consegna orfana, e quella dell'altro item resta intatta.
    const orfane = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE item_id = 1").get() as { n: number };
    expect(orfane.n).toBe(0);
    expect(await s.isDelivered(111, 2, "digest")).toBe(true);

    expect(await s.deleteItems([4242])).toBe(0);
    expect(await s.deleteItems([])).toBe(0);
    expect(await s.queryItems({ limit: 10 })).toHaveLength(1);
  });

  it("gestisce preferenze, pesi con tetto e chat attive", async () => {
    await store.upsertPrefs({
      chatId: 111, active: true, weights: { giftcard: 1 }, minScoreInstant: 70, quietHours: "23-7", digestHours: [8, 19],
      filters: defaultFilters(),
    });
    await store.upsertPrefs({
      chatId: 222, active: false, weights: {}, minScoreInstant: 80, quietHours: "0-0", digestHours: [9],
      filters: { ...defaultFilters(), mutedTags: ["raccolta_punti"], freeOnly: true },
    });

    expect((await store.getPrefs(111))?.weights).toEqual({ giftcard: 1 });
    expect(await store.listChats()).toEqual([111]);

    for (let i = 0; i < 10; i++) await store.bumpWeights(111, { giftcard: 1 });
    expect((await store.getPrefs(111))?.weights.giftcard).toBe(5);
    for (let i = 0; i < 20; i++) await store.bumpWeights(111, { giftcard: -1 });
    expect((await store.getPrefs(111))?.weights.giftcard).toBe(-5);
    // Il tetto non deve aver toccato il resto delle preferenze.
    expect((await store.getPrefs(111))?.minScoreInstant).toBe(70);
  });

  it("ricorda cosa è già stato consegnato a ciascuna chat", async () => {
    expect(await store.isDelivered(111, 1, "digest")).toBe(false);
    await store.recordDelivery(111, 1, "digest", "2026-10-16T08:05:00.000Z");
    await store.recordDelivery(222, 1, "digest", "2026-10-16T08:06:00.000Z");
    expect(await store.isDelivered(111, 1, "digest")).toBe(true);
    expect(await store.isDelivered(111, 1, "instant")).toBe(false);
    expect(await store.lastDeliveryAt(111, "digest")).toBe("2026-10-16T08:05:00.000Z");

    // Lo stesso invio ripetuto aggiorna la data invece di duplicare la riga.
    await store.recordDelivery(111, 1, "digest", "2026-10-16T19:05:00.000Z");
    expect(await store.lastDeliveryAt(111, "digest")).toBe("2026-10-16T19:05:00.000Z");
  });

  it("deduplica gli update di Telegram contando i changes", async () => {
    expect(await store.claimUpdate(5001, "2026-10-16T08:00:00.000Z")).toBe(true);
    expect(await store.claimUpdate(5001, "2026-10-16T08:00:01.000Z")).toBe(false);
    expect(await store.claimUpdate(5002, "2026-10-16T08:00:02.000Z")).toBe(true);
  });

  it("registra le esecuzioni e le restituisce dalla più recente", async () => {
    await store.recordRun({ startedAt: "2026-10-16T08:00:00.000Z", trigger: "*/15 * * * *", sourcesOk: 2, sourcesFail: 1, itemsNew: 3, ms: 900, note: "primo" });
    await store.recordRun({ startedAt: "2026-10-16T09:00:00.000Z", trigger: "5 6 * * *", sourcesOk: 0, sourcesFail: 0, itemsNew: 0, ms: 20, note: "digest" });

    const runs = await store.recentRuns(5);
    expect(runs.map((run) => run.note)).toEqual(["digest", "primo"]);
    expect(runs[1].itemsNew).toBe(3);
  });

  it("conserva la cache di robots.txt e il consumo AI giornaliero", async () => {
    expect(await store.getRobots("https://a.example")).toBeNull();
    await store.saveRobots("https://a.example", "User-agent: *", "2026-10-16T08:00:00.000Z");
    expect((await store.getRobots("https://a.example"))?.body).toBe("User-agent: *");
    await store.saveRobots("https://a.example", "Disallow: /", "2026-10-17T08:00:00.000Z");
    expect((await store.getRobots("https://a.example"))?.body).toBe("Disallow: /");

    expect(await store.aiUsage("2026-10-16")).toBe(0);
    await store.addAiUsage("2026-10-16", 2, 40);
    await store.addAiUsage("2026-10-16", 3, 60);
    expect(await store.aiUsage("2026-10-16")).toBe(100);
  });

  it("registra l'esito di una fonte senza perdere l'etag precedente", async () => {
    const { db, store: s } = freshStore();
    db.prepare(
      `INSERT INTO sources (id, name, kind, url, category, tags, cadence_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("fonte-a", "Aggregatore A", "rss", "https://a.example/feed", "online", "[]", 15, 1);

    await s.recordSourceRun("fonte-a", {
      ok: true, httpStatus: 200, etag: "etag-1", lastModified: null, error: null, now: "2026-10-16T08:00:00.000Z",
    });
    let row = (await s.getSources())[0];
    expect(row.etag).toBe("etag-1");
    expect(row.failStreak).toBe(0);
    expect(row.lastOkAt).toBe("2026-10-16T08:00:00.000Z");

    await s.recordSourceRun("fonte-a", {
      ok: false, httpStatus: 503, etag: null, lastModified: null, error: "HTTP 503", now: "2026-10-16T08:15:00.000Z",
    });
    row = (await s.getSources())[0];
    expect(row.etag).toBe("etag-1");
    expect(row.failStreak).toBe(1);
    expect(row.lastRunAt).toBe("2026-10-16T08:15:00.000Z");
  });

  it("conserva i filtri della chat senza toccare le altre preferenze", async () => {
    await store.upsertPrefs({
      chatId: 111, active: true, weights: {}, minScoreInstant: 80, quietHours: "23-7", digestHours: [8, 19],
      filters: { ...defaultFilters(), mutedTags: ["food"], mutedCategories: ["scontrino"], freeOnly: true },
    });
    const prefs = await store.getPrefs(111);
    expect(prefs?.filters.mutedTags).toEqual(["food"]);
    expect(prefs?.filters.mutedCategories).toEqual(["scontrino"]);
    expect(prefs?.filters.freeOnly).toBe(true);

    // Il percorso dei pesi riscrive la riga: i filtri devono restare.
    await store.bumpWeights(111, { giftcard: 1 });
    expect((await store.getPrefs(111))?.filters).toEqual(prefs?.filters);
    expect((await store.getPrefs(111))?.quietHours).toBe("23-7");
  });

  it("i filtri escludono davvero: fonte, tag e obbligo di acquisto, in SQL", async () => {
    await store.insertItem(item({ urlKey: "key-1", url: "https://a.example/1", sourceId: "vincimi", tags: ["giftcard"], requiresPurchase: false }));
    await store.insertItem(
      item({ urlKey: "key-2", url: "https://b.example/2", title: "Raccolta bollini Bennet", sourceId: "sitemap-conad", tags: ["raccolta_punti", "brand"], requiresPurchase: true }),
    );
    await store.insertItem(
      item({ urlKey: "key-3", url: "https://c.example/3", title: "Concorso con moda", sourceId: "premieconcorsi", tags: ["moda"], requiresPurchase: false }),
    );

    expect(await store.countItems({})).toBe(3);
    expect(await store.countItems({ excludeSources: ["vincimi"] })).toBe(2);
    expect(await store.countItems({ excludeTags: ["raccolta_punti"] })).toBe(2);
    expect(await store.countItems({ withoutPurchase: true })).toBe(2);
    expect((await store.queryItems({ excludeTags: ["raccolta_punti"], limit: 10 })).map((row) => row.sourceId)).toEqual([
      "premieconcorsi",
      "vincimi",
    ]);

    // "moda" non deve escludere un eventuale "moda_bambini": è un confronto fra
    // elementi dell'array JSON, non una ricerca per somiglianza.
    await store.insertItem(
      item({ urlKey: "key-4", url: "https://d.example/4", title: "Concorso bambini moda", sourceId: "vincimi", tags: ["moda_bambini"], requiresPurchase: false }),
    );
    expect(await store.countItems({ excludeTags: ["moda"] })).toBe(3);

    // Le tre esclusioni insieme, come le manda una chat con i filtri accesi:
    // restano il giftcard gratuito di Vincimi e il concorso "moda_bambini".
    const filtri = { ...defaultFilters(), mutedSources: ["sitemap-conad"], mutedTags: ["moda"], freeOnly: true };
    expect(await store.countItems(filtersFor(filtri, {}))).toBe(2);
  });
});
