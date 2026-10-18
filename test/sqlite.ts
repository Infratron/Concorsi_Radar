import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { D1Like, D1LikeStatement } from "../src/db/d1.ts";

/**
 * D1 su SQLite vero, per i test: lo stesso SQL dello store eseguito da
 * `node:sqlite` su un database in memoria. Una copia sola, condivisa.
 */

export const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export const SCHEMA = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");

export function sqliteBinding(db: DatabaseSync): D1Like {
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

/** Un database in memoria con lo schema di produzione già applicato. */
export function schemaDb(): DatabaseSync {
  const db = new Sqlite(":memory:");
  db.exec(SCHEMA);
  return db;
}
