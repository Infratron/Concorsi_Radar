import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { createD1Store, type D1Like, type D1LikeStatement } from "../src/db/d1.ts";
import { NOTIFY_CRON } from "../src/schedule.ts";
import type { Env } from "../src/types.ts";

/**
 * Il tick del Worker, eseguito davvero: `scheduled()` dell'entry point, il D1 su
 * SQLite vero e la rete finta.
 *
 * Perché questo test esiste: l'orchestrazione del cron (raccolta di riserva,
 * promemoria, nota dell'esecuzione) non è coperta da nessun altro test — i moduli
 * sì, il modo in cui vengono messi in fila no. Ed è il punto in cui i guasti
 * restano invisibili: un promemoria che non parte non fa rumore, quindi l'unica
 * difesa è una prova che lo faccia partire.
 *
 * La rete è tutta finta: api.telegram.org risponde ok e tutto il resto 404, così
 * la raccolta di riserva fallisce senza uscire da qui (è il caso di produzione in
 * cui la rete di Cloudflare viene bloccata).
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

/** 20/11/2026 11:00 a Roma: fuori dalla fascia di silenzio. */
const NOW = new Date("2026-11-20T10:00:00.000Z");
const ADMIN = 4242;
const ORA_MS = 3_600_000;

interface Inviato {
  chatId: number;
  testo: string;
}

function makeWorld() {
  const db = new Sqlite(":memory:");
  db.exec(readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
  const store = createD1Store(sqliteBinding(db));
  const inviati: Inviato[] = [];
  const rete: string[] = [];

  const fetchFinto = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = String(input);
    rete.push(url);
    if (!url.includes("api.telegram.org")) return new Response("not found", { status: 404 });

    const metodo = url.split("/").pop() ?? "";
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (metodo === "sendMessage") {
      inviati.push({ chatId: Number(payload.chat_id), testo: String(payload.text) });
      return Response.json({ ok: true, result: { message_id: inviati.length } });
    }
    return Response.json({ ok: true, result: true });
  };

  const env = {
    DB: sqliteBinding(db),
    AI: undefined,
    TELEGRAM_BOT_TOKEN: "finto-token",
    WEBHOOK_SECRET: "finto-segreto",
    ADMIN_CHAT_ID: String(ADMIN),
    ALLOWED_CHAT_IDS: String(ADMIN),
  } as unknown as Env;

  return { db, store, env, inviati, rete, fetchFinto };
}

/** Esegue il tick come farebbe il cron e restituisce quando ha finito. */
async function tick(world: ReturnType<typeof makeWorld>, now: Date, cron = NOTIFY_CRON): Promise<void> {
  const attese: Promise<unknown>[] = [];
  await worker.scheduled(
    { cron, scheduledTime: now.getTime(), type: "scheduled" } as unknown as ScheduledController,
    world.env,
    { waitUntil: (promise: Promise<unknown>) => attese.push(promise) } as unknown as ExecutionContext,
  );
  await Promise.all(attese);
}

/** Le note delle ultime esecuzioni, dalla più recente. */
async function note(world: ReturnType<typeof makeWorld>): Promise<string[]> {
  const rows = await world.store.recentRuns(5);
  return rows.map((run) => run.note ?? "");
}

describe("cron · il tick completo", () => {
  let world: ReturnType<typeof makeWorld>;
  let fetchOriginale: typeof globalThis.fetch;

  beforeEach(() => {
    world = makeWorld();
    fetchOriginale = globalThis.fetch;
    globalThis.fetch = world.fetchFinto as unknown as typeof globalThis.fetch;
  });

  // La rete finta vale solo dentro questi test: il resto della suite resta offline.
  afterEach(() => {
    globalThis.fetch = fetchOriginale;
  });

  it("avvisa l'admin se la raccolta su GitHub è ferma da ore", async () => {
    world.db.exec(`
      INSERT INTO prefs (chat_id, active, weights, min_score_instant, quiet_hours, digest_hours, filters, updated_at)
      VALUES (${ADMIN}, 1, '{}', 80, '23-7', '[8,19]', '{}', '2026-11-20T06:00:00.000Z');
    `);
    await world.store.recordRun({
      startedAt: new Date(NOW.getTime() - 4 * ORA_MS).toISOString(),
      trigger: "actions", sourcesOk: 12, sourcesFail: 0, itemsNew: 5, ms: 1000, note: "actions",
    });

    await tick(world, NOW);

    const avviso = world.inviati.find((inviato) => inviato.chatId === ADMIN && inviato.testo.includes("Raccolta ferma"));
    expect(avviso, "il promemoria deve partire verso l'admin").toBeDefined();
    expect(avviso?.testo).toContain("Raccolta ferma da 4 ore");
    expect(avviso?.testo).toContain("L'ultima raccolta su GitHub è girata 4 ore fa");
    expect(avviso?.testo).toContain("CLOUDFLARE_API_TOKEN");

    // Il tick registra di averlo mandato: è così che il prossimo giro lo sa.
    expect((await note(world))[0]).toContain("promemoria raccolta: inviato");
  });

  it("non lo ripete al tick successivo", async () => {
    world.db.exec(`
      INSERT INTO prefs (chat_id, active, weights, min_score_instant, quiet_hours, digest_hours, filters, updated_at)
      VALUES (${ADMIN}, 1, '{}', 80, '23-7', '[8,19]', '{}', '2026-11-20T06:00:00.000Z');
    `);
    await world.store.recordRun({
      startedAt: new Date(NOW.getTime() - 4 * ORA_MS).toISOString(),
      trigger: "actions", sourcesOk: 12, sourcesFail: 0, itemsNew: 5, ms: 1000, note: "actions",
    });

    await tick(world, NOW);
    const dopoIlPrimo = world.inviati.filter((inviato) => inviato.testo.includes("Raccolta ferma")).length;
    expect(dopoIlPrimo).toBe(1);

    await tick(world, new Date(NOW.getTime() + 15 * 60_000));

    expect(world.inviati.filter((inviato) => inviato.testo.includes("Raccolta ferma"))).toHaveLength(1);
    expect((await note(world))[0]).toContain("promemoria raccolta: no");
  });

  it("con la raccolta che gira non manda nessun promemoria", async () => {
    world.db.exec(`
      INSERT INTO prefs (chat_id, active, weights, min_score_instant, quiet_hours, digest_hours, filters, updated_at)
      VALUES (${ADMIN}, 1, '{}', 80, '23-7', '[8,19]', '{}', '2026-11-20T06:00:00.000Z');
    `);
    await world.store.recordRun({
      startedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
      trigger: "actions", sourcesOk: 12, sourcesFail: 0, itemsNew: 3, ms: 1000, note: "actions",
    });

    await tick(world, NOW);

    expect(world.inviati.filter((inviato) => inviato.testo.includes("Raccolta ferma"))).toHaveLength(0);
    expect((await note(world))[0]).toContain("promemoria raccolta: no");
  });

  it("senza nessuna raccolta registrata lo dice senza inventare una data", async () => {
    world.db.exec(`
      INSERT INTO prefs (chat_id, active, weights, min_score_instant, quiet_hours, digest_hours, filters, updated_at)
      VALUES (${ADMIN}, 1, '{}', 80, '23-7', '[8,19]', '{}', '2026-11-20T06:00:00.000Z');
    `);
    // Solo tick del Worker: della raccolta su GitHub non resta niente.
    await world.store.recordRun({
      startedAt: new Date(NOW.getTime() - 15 * 60_000).toISOString(),
      trigger: NOTIFY_CRON, sourcesOk: 1, sourcesFail: 3, itemsNew: 0, ms: 900, note: "tick",
    });

    await tick(world, NOW);

    const avviso = world.inviati.find((inviato) => inviato.testo.includes("Raccolta ferma"));
    expect(avviso?.testo).toContain("Su GitHub non risulta nessuna raccolta in questo periodo");
  });
});
