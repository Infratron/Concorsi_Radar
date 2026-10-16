import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1HttpBinding, createD1HttpStore, d1HttpOptionsFromEnv } from "../src/db/d1-http.ts";
import { simhash } from "../src/lib/text.ts";
import type { NewItem } from "../src/types.ts";

/**
 * L'adapter HTTP di D1 serve alla raccolta che gira su GitHub Actions. Qui il
 * finto API non risponde "a comando": esegue l'SQL su SQLite vero e incapsula il
 * risultato nella forma dell'API di Cloudflare. Così il test copre il tragitto
 * completo — store → corpo JSON → righe di risposta — senza usare la rete.
 */

const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

interface Chiamata {
  url: string;
  method: string;
  authorization: string | null;
  sql: string;
  params: unknown[];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** Finto API di D1: esegue davvero le query, con la forma della risposta vera. */
function fakeD1Api(db: DatabaseSync, chiamate: Chiamata[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new URL(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as { sql?: string; params?: unknown[] };
    const sql = String(body.sql ?? "");
    const params = body.params ?? [];
    chiamate.push({
      url: request.pathname,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      sql,
      params,
    });

    const statement = db.prepare(sql);
    const args = params as SQLInputValue[];
    const restituisceRighe = /^\s*select/i.test(sql) || /returning/i.test(sql);
    if (restituisceRighe) {
      return jsonResponse({ success: true, result: [{ results: statement.all(...args), meta: { changes: 0 } }] });
    }
    const info = statement.run(...args);
    return jsonResponse({ success: true, result: [{ results: [], meta: { changes: Number(info.changes) } }] });
  };
}

function newItem(overrides: Partial<NewItem> = {}): NewItem {
  const title = overrides.title ?? "Concorso Barilla vinci una Fiat Panda";
  return {
    sourceId: "premieconcorsi",
    url: "https://a.example/barilla",
    urlKey: "key-barilla",
    simhash: simhash(title),
    title,
    summary: "In palio una Fiat Panda.",
    publishedAt: null,
    firstSeenAt: "2026-10-16T08:00:00.000Z",
    lastSeenAt: "2026-10-16T08:00:00.000Z",
    deadline: "2026-10-25",
    prize: "Fiat Panda",
    participation: "gratis",
    prizeValue: 20000,
    effort: 1,
    requiresPurchase: false,
    tags: ["auto"],
    score: 90,
    clusterId: null,
    status: "new",
    aiUsed: false,
    ...overrides,
  };
}

describe("store D1 via API HTTP", () => {
  let db: DatabaseSync;
  let chiamate: Chiamata[];

  beforeEach(() => {
    db = new Sqlite(":memory:");
    db.exec(readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    chiamate = [];
  });

  function store() {
    return createD1HttpStore({
      accountId: "acc-123",
      databaseId: "db-456",
      apiToken: "segreto-di-prova",
      apiBase: "https://api.example/client/v4",
      fetcher: fakeD1Api(db, chiamate),
    });
  }

  it("chiama l'endpoint giusto con il token e i parametri separati dall'SQL", async () => {
    await createD1HttpStore({
      accountId: "acc-123",
      databaseId: "db-456",
      apiToken: "segreto-di-prova",
      apiBase: "https://api.example/client/v4",
      fetcher: fakeD1Api(db, chiamate),
    }).getItem(7);

    expect(chiamate).toHaveLength(1);
    const [first] = chiamate;
    expect(first.url).toBe("/client/v4/accounts/acc-123/d1/database/db-456/query");
    expect(first.method).toBe("POST");
    expect(first.authorization).toBe("Bearer segreto-di-prova");
    expect(first.sql).toContain("SELECT * FROM items WHERE id = ?");
    // Il valore viaggia nei parametri: nessuna interpolazione di stringhe.
    expect(first.params).toEqual([7]);
  });

  it("accoda una chiamata per bind, senza riusare i parametri precedenti", async () => {
    const binding = createD1HttpBinding({
      accountId: "acc", databaseId: "db", apiToken: "t", apiBase: "https://api.example", fetcher: fakeD1Api(db, chiamate),
    });
    const prepared = binding.prepare("SELECT ? AS uno, ? AS due");
    const conUno = prepared.bind(1);
    await conUno.all();
    await conUno.bind(1, 2).all();

    expect(chiamate.map((c) => c.params)).toEqual([[1], [1, 2]]);
  });

  it("esegue lo store completo: inserimento, lettura, deduplica e idempotenza del webhook", async () => {
    const s = store();

    const inserted = await s.insertItem(newItem());
    expect(inserted.created).toBe(true);
    expect(inserted.item.id).toBe(1);
    expect(inserted.item.tags).toEqual(["auto"]);

    const again = await s.insertItem(newItem({ url: "https://b.example/barilla" }));
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(1);

    expect((await s.getItem(1))?.title).toBe("Concorso Barilla vinci una Fiat Panda");
    const candidati = await s.findDuplicateCandidates("key-barilla", "ffffffffffffffff", "2026-10-01T00:00:00.000Z");
    expect(candidati.map((row) => row.id)).toEqual([1]);

    // `changes` attraversa il JSON dell'API: è la base dell'idempotenza.
    expect(await s.claimUpdate(9001, "2026-10-16T08:00:00.000Z")).toBe(true);
    expect(await s.claimUpdate(9001, "2026-10-16T08:00:01.000Z")).toBe(false);

    await s.recordDelivery(111, 1, "instant", "2026-10-16T08:00:00.000Z");
    expect(await s.isDelivered(111, 1, "instant")).toBe(true);

    await s.recordRun({ startedAt: "2026-10-16T08:00:00.000Z", trigger: "actions", sourcesOk: 3, sourcesFail: 0, itemsNew: 2, ms: 800, note: "raccolta" });
    expect((await s.recentRuns(5))[0].note).toBe("raccolta");
  });

  it("segnala l'errore dell'API invece di restituire righe vuote", async () => {
    const failHttp = createD1HttpStore({
      accountId: "a", databaseId: "d", apiToken: "t", apiBase: "https://api.example",
      fetcher: async () => jsonResponse({ success: false, errors: [{ code: 7500, message: "no such table: items" }] }, 400),
    });
    await expect(failHttp.getItem(1)).rejects.toThrow(/D1 API 400.*no such table/);

    const failBody = createD1HttpStore({
      accountId: "a", databaseId: "d", apiToken: "t", apiBase: "https://api.example",
      fetcher: async () => jsonResponse({ success: false, errors: [{ message: "authentication error" }] }),
    });
    await expect(failBody.getSources()).rejects.toThrow(/authentication error/);
  });

  it("legge le credenziali dall'ambiente e dice cosa manca", () => {
    expect(() => d1HttpOptionsFromEnv({})).toThrow(/CLOUDFLARE_ACCOUNT_ID.*CLOUDFLARE_API_TOKEN.*D1_DATABASE_ID/);
    expect(() => d1HttpOptionsFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", D1_DATABASE_ID: "d" })).toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(d1HttpOptionsFromEnv({ CLOUDFLARE_ACCOUNT_ID: " acc ", CLOUDFLARE_API_TOKEN: " tok ", D1_DATABASE_ID: " db " })).toEqual({
      accountId: "acc", apiToken: "tok", databaseId: "db",
    });
  });

  it("permette di puntare a un finto API locale, senza toccare l'indirizzo vero", () => {
    const conBase = d1HttpOptionsFromEnv({
      CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", D1_DATABASE_ID: "d",
      D1_API_BASE: "http://127.0.0.1:8799/client/v4",
    });
    expect(conBase.apiBase).toBe("http://127.0.0.1:8799/client/v4");
    // Senza la variabile resta il Cloudflare vero (l'opzione è assente, non vuota).
    expect(d1HttpOptionsFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", D1_DATABASE_ID: "d" })).not.toHaveProperty("apiBase");
    expect(d1HttpOptionsFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", D1_DATABASE_ID: "d", D1_API_BASE: "  " })).not.toHaveProperty("apiBase");
  });
});
