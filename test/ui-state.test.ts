import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createD1Store } from "../src/db/d1.ts";
import { createMemoryStore } from "../src/db/memory.ts";
import type { Store } from "../src/db/store.ts";
import { simhash } from "../src/lib/text.ts";
import type { NewItem, ItemQuery, UiState } from "../src/types.ts";
import { Sqlite, sqliteBinding } from "./sqlite.ts";

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

/**
 * Uno stato dell'interfaccia con l'ora dichiarata: `updatedAt` è il campo che
 * dice se il messaggio salvato è ancora quello in chat, quindi i test lo
 * scrivono invece di lasciarlo al caso (l'ora vera del salvataggio).
 */
const ULTIMA_INTERAZIONE = "2026-10-16T12:00:00.000Z";

function stato(chatId: number, overrides: Partial<UiState> = {}): UiState {
  return {
    chatId,
    messageId: null,
    section: "menu",
    page: 0,
    openItemId: null,
    lastCheckAt: null,
    updatedAt: ULTIMA_INTERAZIONE,
    ...overrides,
  };
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

  it("conserva la storia di navigazione, e la dimentica quando torna vuota", async () => {
    const store = crea();
    const storia = [
      { section: "menu", page: 0 },
      { section: "settimana", page: 4 },
    ];
    await store.saveUiState(stato(42, { section: "settimana", page: 4, history: storia }));
    expect((await store.getUiState(42))?.history).toEqual(storia);

    // Vuota = campo assente, in entrambe le implementazioni: una riga vecchia
    // (scritta prima della colonna) e una senza storia si leggono uguali.
    await store.saveUiState(stato(42, { section: "menu" }));
    expect(await store.getUiState(42)).not.toHaveProperty("history");
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

  it("chi non dichiara l'ora dell'interazione la riceve dal salvataggio", async () => {
    // La colonna è NOT NULL e il campo non può essere "non lo so" in archivio:
    // l'ora del salvataggio è l'unico valore che non fa credere a una chat ferma
    // da mesi. Le due implementazioni devono dirlo allo stesso modo.
    const store = crea();
    await store.saveUiState(stato(42, { updatedAt: null }));
    const riletto = await store.getUiState(42);
    expect(riletto?.updatedAt).not.toBeNull();
    expect(Number.isFinite(Date.parse(String(riletto?.updatedAt)))).toBe(true);
  });

  it("l'ora dell'interazione si rilegge come è stata scritta", async () => {
    const store = crea();
    await store.saveUiState(stato(42, { updatedAt: "2026-10-16T09:30:00.000Z" }));
    expect((await store.getUiState(42))?.updatedAt).toBe("2026-10-16T09:30:00.000Z");
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
      // Il secondo non chiede l'acquisto: è l'unica cosa che la sezione 🆓 Gratis
      // guarda, e i due store devono rispondere lo stesso numero.
      const secondo = await store.insertItem(
        item({
          urlKey: "k2",
          title: "Vinci un viaggio in Sardegna",
          score: 40,
          requiresPurchase: false,
          // Un tag di tipo di premio: è quello che leggono le porte di
          // 🎁 Tipi di premio, in inclusione (l'esclusione è l'altra metà).
          tags: ["buoni_spesa", "viaggio"],
        }),
      );
      await store.recordDelivery(42, primo.item.id, "saved", "2026-10-16T08:00:00.000Z");
      await store.recordDelivery(42, secondo.item.id, "saved", "2026-10-16T09:00:00.000Z");
      await store.saveUiState(stato(42, { messageId: 3, section: "salvati", page: 1, lastCheckAt: "2026-10-16T10:00:00.000Z" }));

      return {
        ui: await store.getUiState(42),
        salvati: (await store.listDeliveredItems(42, "saved")).map((row) => row.urlKey),
        nuovi: await store.countItems({ since: "2026-10-10T00:00:00.000Z" }),
        salvatiCosi: await store.countItems({ statuses: ["saved"] }),
        gratis: await store.countItems({ kinds: ["contest"], statuses: ["new", "sent"], withoutPurchase: true }),
        // Inclusione per tag: le due implementazioni la leggono allo stesso modo
        // e nello stesso ordine (ordinati per punteggio, id come spareggio).
        premi: (
          await store.queryItems({
            kinds: ["contest"],
            statuses: ["new", "sent"],
            tags: ["viaggio", "giftcard"],
            orderBy: "score",
            limit: 10,
          })
        ).map((row) => row.urlKey),
      };
    };

    expect(await scenario(d1Store())).toEqual(await scenario(createMemoryStore()));
  });
});
