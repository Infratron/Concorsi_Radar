import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createD1Store, type D1Like, type D1LikeStatement } from "../src/db/d1.ts";
import { createMemoryStore } from "../src/db/memory.ts";
import type { Store } from "../src/db/store.ts";
import { simhash } from "../src/lib/text.ts";
import type { NewItem, ItemQuery, UiState } from "../src/types.ts";

/**
 * Lo stato dell'interfaccia in chat (il messaggio unico che il bot modifica) e i
 * due metodi che servono alle schermate: la scheda "salvati" e i conteggi del
 * menù. Qui l'SQL gira su SQLite vero e le stesse asserzioni passano anche sullo
 * store in-memory: se le due implementazioni divergono, il test lo dice prima
 * che lo faccia la chat.
 */

/**
 * `node:sqlite` va caricato a runtime: Vite toglierebbe il prefisso `node:` e
 * cercherebbe un pacchetto chiamato `sqlite`, che non esiste.
 */
const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function sqliteBinding(db: DatabaseSync): D1Like {
  const statement = (sql: string, params: unknown[]): D1LikeStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => ((db.prepare(sql).get(...(params as SQLInputValue[])) as unknown as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...(params as SQLInputValue[])) as unknown as T[] }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql, []) };
}

function d1Store(): Store {
  const db = new Sqlite(":memory:");
  db.exec(readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
  return createD1Store(sqliteBinding(db));
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

function stato(chatId: number, overrides: Partial<UiState> = {}): UiState {
  return { chatId, messageId: null, section: "menu", page: 0, openItemId: null, lastCheckAt: null, ...overrides };
}

/** Le tre implementazioni dello stesso contratto, per confrontarle a parità di codice. */
const stores: { nome: string; crea: () => Store }[] = [
  { nome: "D1 su SQLite", crea: d1Store },
  { nome: "in-memory", crea: () => createMemoryStore() },
];

describe.each(stores)("stato dell'interfaccia · $nome", ({ crea }) => {
  it("nasce vuoto e si rilegge esattamente come è stato scritto", async () => {
    const store = crea();
    expect(await store.getUiState(42)).toBeNull();

    // Primo salvataggio: nessun messaggio ancora inviato e nessun controllo fatto.
    const vuoto = stato(42);
    await store.saveUiState(vuoto);
    expect(await store.getUiState(42)).toEqual(vuoto);

    // Stato pieno: sezione con la query dentro, pagina avanzata, scheda aperta.
    const pieno = stato(42, {
      messageId: 99,
      section: "cerca:buoni spesa",
      page: 2,
      openItemId: 7,
      lastCheckAt: "2026-10-16T10:00:00.000Z",
    });
    await store.saveUiState(pieno);
    expect(await store.getUiState(42)).toEqual(pieno);
  });

  it("riscrive in place invece di accumulare righe, e le chat non si disturbano", async () => {
    const store = crea();
    await store.saveUiState(stato(42, { messageId: 10 }));
    await store.saveUiState(stato(99, { messageId: 20, section: "fonti" }));
    await store.saveUiState(stato(42, { messageId: 11, section: "salvati", page: 1 }));

    expect(await store.getUiState(42)).toEqual(stato(42, { messageId: 11, section: "salvati", page: 1 }));
    expect(await store.getUiState(99)).toEqual(stato(99, { messageId: 20, section: "fonti" }));

    // Un salvataggio non deve toccare l'altra chat: `ui` ha una riga per chat.
    await store.saveUiState(stato(42, { messageId: 12 }));
    expect((await store.getUiState(99))?.messageId).toBe(20);
  });

  it("accetta un item tornato a null dopo una cancellazione nell'app", async () => {
    const store = crea();
    await store.saveUiState(stato(42, { messageId: 5, openItemId: 3 }));
    await store.saveUiState(stato(42, { messageId: 5, openItemId: null }));
    expect((await store.getUiState(42))?.openItemId).toBeNull();
  });
});

describe.each(stores)("consegne per chat · $nome", ({ crea }) => {
  it("elenca gli item di quella chat e di quel tipo, dal più recente", async () => {
    const store = crea();
    const primo = await store.insertItem(item({ urlKey: "k1", title: "Vinci buoni spesa Esselunga" }));
    const secondo = await store.insertItem(item({ urlKey: "k2", title: "Vinci un viaggio in Sardegna" }));
    const terzo = await store.insertItem(item({ urlKey: "k3", title: "Concorso caffè Illy" }));

    await store.recordDelivery(42, primo.item.id, "saved", "2026-10-16T08:00:00.000Z");
    await store.recordDelivery(42, terzo.item.id, "saved", "2026-10-16T12:00:00.000Z");
    await store.recordDelivery(42, secondo.item.id, "ignored", "2026-10-16T09:00:00.000Z");
    await store.recordDelivery(99, secondo.item.id, "saved", "2026-10-16T10:00:00.000Z");

    // L'ordine è quello delle consegne, non degli id: l'ultimo salvato è in cima.
    expect((await store.listDeliveredItems(42, "saved")).map((row) => row.urlKey)).toEqual(["k3", "k1"]);
    expect((await store.listDeliveredItems(42, "ignored")).map((row) => row.urlKey)).toEqual(["k2"]);
    expect((await store.listDeliveredItems(99, "saved")).map((row) => row.urlKey)).toEqual(["k2"]);
    expect(await store.listDeliveredItems(42, "won")).toEqual([]);
    expect(await store.listDeliveredItems(7, "saved")).toEqual([]);

    expect((await store.listDeliveredItems(42, "saved", 1)).map((row) => row.urlKey)).toEqual(["k3"]);
  });

  it("restituisce la riga intera, non solo l'id", async () => {
    const store = crea();
    const inserito = await store.insertItem(item({ urlKey: "k1", score: 88, deadline: "2026-11-30" }));
    await store.recordDelivery(42, inserito.item.id, "saved", "2026-10-16T08:00:00.000Z");

    const [riga] = await store.listDeliveredItems(42, "saved");
    expect(riga.score).toBe(88);
    expect(riga.deadline).toBe("2026-11-30");
    expect(riga.tags).toEqual(["buoni_spesa"]);
    expect(riga.requiresPurchase).toBe(true);
  });
});

describe.each(stores)("conteggi del menù · $nome", ({ crea }) => {
  async function popolato(): Promise<Store> {
    const store = crea();
    await store.insertItem(
      item({ urlKey: "k1", title: "Vinci buoni spesa Esselunga", score: 90, deadline: "2026-10-20" }),
    );
    await store.insertItem(
      item({ urlKey: "k2", title: "Vinci un viaggio in Sardegna", score: 30, deadline: null, firstSeenAt: "2026-10-01T08:00:00.000Z" }),
    );
    await store.insertItem(
      item({ urlKey: "k3", title: "Concorso caffè Illy", score: 60, deadline: "2026-12-01", status: "saved" }),
    );
    return store;
  }

  it("conta esattamente le righe che queryItems restituirebbe", async () => {
    const store = await popolato();
    const query: ItemQuery[] = [
      {},
      { statuses: ["saved"] },
      { statuses: ["new", "sent"] },
      { minScore: 60 },
      { keyword: "esselunga" },
      { keyword: "CONCORSO" },
      { deadlineBefore: "2026-11-01" },
      { since: "2026-10-10T00:00:00.000Z" },
      { excludeIds: [1] },
      { minScore: 95 },
    ];

    for (const q of query) {
      const righe = await store.queryItems({ ...q, limit: 200 });
      expect(await store.countItems(q)).toBe(righe.length);
    }
  });

  it("conta senza tagliare al limite di queryItems", async () => {
    const store = crea();
    for (let indice = 0; indice < 25; indice++) {
      await store.insertItem(item({ urlKey: `k${indice}`, title: `Concorso numero ${indice}`, score: 50 }));
    }

    // queryItems ha un tetto (default 20): il conteggio del menù no.
    expect((await store.queryItems({})).length).toBe(20);
    expect(await store.countItems({})).toBe(25);
    expect(await store.countItems({ minScore: 60 })).toBe(0);
  });
});

describe("le due implementazioni concordano", () => {
  it("stesso scenario, stessi risultati", async () => {
    const scenario = async (store: Store): Promise<unknown> => {
      const primo = await store.insertItem(item({ urlKey: "k1", title: "Vinci buoni spesa Esselunga", score: 90 }));
      const secondo = await store.insertItem(item({ urlKey: "k2", title: "Vinci un viaggio in Sardegna", score: 40 }));
      await store.recordDelivery(42, primo.item.id, "saved", "2026-10-16T08:00:00.000Z");
      await store.recordDelivery(42, secondo.item.id, "saved", "2026-10-16T09:00:00.000Z");
      await store.saveUiState(stato(42, { messageId: 3, section: "salvati", page: 1, lastCheckAt: "2026-10-16T10:00:00.000Z" }));

      return {
        ui: await store.getUiState(42),
        salvati: (await store.listDeliveredItems(42, "saved")).map((row) => row.urlKey),
        nuovi: await store.countItems({ since: "2026-10-10T00:00:00.000Z" }),
        salvatiCosi: await store.countItems({ statuses: ["saved"] }),
      };
    };

    expect(await scenario(d1Store())).toEqual(await scenario(createMemoryStore()));
  });
});
