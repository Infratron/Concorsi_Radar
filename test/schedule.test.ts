import { describe, expect, it } from "vitest";
import { DIGEST_CRONS, INGEST_CRON, isDigestWindow, jobFor } from "../src/schedule.ts";

/**
 * Il cron è in UTC, gli utenti ragionano in ora italiana: qui blocchiamo la
 * conversione, compreso il cambio d'ora che sposta il digest di un'ora.
 */

describe("jobFor", () => {
  it("i cron dei digest lanciano il digest", () => {
    for (const cron of DIGEST_CRONS) {
      expect(jobFor(cron, new Date("2026-10-16T06:05:00.000Z"), [8, 19])).toBe("digest");
    }
  });

  it("il cron dei quindici minuti lancia sempre l'ingestione", () => {
    expect(jobFor(INGEST_CRON, new Date("2026-10-16T06:05:00.000Z"), [8, 19])).toBe("ingest");
    expect(jobFor(INGEST_CRON, new Date("2026-10-16T17:05:00.000Z"), [8, 19])).toBe("ingest");
  });

  it("un cron personalizzato ricade nel digest solo nella finestra oraria", () => {
    expect(jobFor("0 * * * *", new Date("2026-10-16T06:05:00.000Z"), [8, 19])).toBe("digest");
    expect(jobFor("0 * * * *", new Date("2026-10-16T12:00:00.000Z"), [8, 19])).toBe("ingest");
  });
});

describe("isDigestWindow", () => {
  it("riconosce le 8 e le 19 italiane in ora legale", () => {
    // 16/10/2026: Italia in CEST (UTC+2) → 06:05Z = 08:05, 17:05Z = 19:05.
    expect(isDigestWindow(new Date("2026-10-16T06:05:00.000Z"), [8, 19])).toBe(true);
    expect(isDigestWindow(new Date("2026-10-16T17:05:00.000Z"), [8, 19])).toBe(true);
  });

  it("tollera lo slittamento di un'ora in ora solare", () => {
    // 16/12/2026: Italia in CET (UTC+1) → 06:05Z = 07:05, 17:05Z = 18:05.
    expect(isDigestWindow(new Date("2026-12-16T06:05:00.000Z"), [8, 19])).toBe(true);
    expect(isDigestWindow(new Date("2026-12-16T17:05:00.000Z"), [8, 19])).toBe(true);
  });

  it("non scatta a metà giornata né di notte", () => {
    expect(isDigestWindow(new Date("2026-10-16T12:00:00.000Z"), [8, 19])).toBe(false);
    expect(isDigestWindow(new Date("2026-10-16T02:00:00.000Z"), [8, 19])).toBe(false);
    expect(isDigestWindow(new Date("2026-10-16T21:00:00.000Z"), [8, 19])).toBe(false);
  });

  it("rispetta un orario scelto dall'utente", () => {
    // 10 italiane = 08:00Z in ora legale.
    expect(isDigestWindow(new Date("2026-10-16T08:00:00.000Z"), [10])).toBe(true);
    expect(isDigestWindow(new Date("2026-10-16T08:00:00.000Z"), [8, 19])).toBe(false);
  });
});
