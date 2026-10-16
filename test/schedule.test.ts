import { describe, expect, it } from "vitest";
import { DIGEST_CRONS, FALLBACK_INGEST_AFTER_MS, NOTIFY_CRON, isDigestWindow, jobFor, shouldFallbackIngest } from "../src/schedule.ts";
import type { RunRow } from "../src/types.ts";

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

  it("il cron dei quindici minuti fa sempre gli avvisi, anche a un'ora da digest", () => {
    // La raccolta la fa GitHub Actions: nel Worker questo tick non ingerisce più.
    expect(jobFor(NOTIFY_CRON, new Date("2026-10-16T06:05:00.000Z"), [8, 19])).toBe("notify");
    expect(jobFor(NOTIFY_CRON, new Date("2026-10-16T17:05:00.000Z"), [8, 19])).toBe("notify");
  });

  it("un cron personalizzato ricade nel digest solo nella finestra oraria", () => {
    expect(jobFor("0 * * * *", new Date("2026-10-16T06:05:00.000Z"), [8, 19])).toBe("digest");
    expect(jobFor("0 * * * *", new Date("2026-10-16T12:00:00.000Z"), [8, 19])).toBe("notify");
  });
});

describe("shouldFallbackIngest", () => {
  function run(trigger: string, startedAt: string): RunRow {
    return { startedAt, trigger, sourcesOk: 0, sourcesFail: 0, itemsNew: 0, ms: 0, note: null };
  }
  const NOW = new Date("2026-10-16T12:00:00.000Z");

  it("senza nessuna esecuzione della raccolta su Actions, il Worker raccoglie", () => {
    expect(shouldFallbackIngest([], NOW)).toBe(true);
    // I tick del Worker non contano come raccolta: solo "actions" lo è.
    expect(shouldFallbackIngest([run("*/15 * * * *", "2026-10-16T11:59:00.000Z")], NOW)).toBe(true);
  });

  it("con una raccolta recente il Worker non tocca i feed", () => {
    expect(shouldFallbackIngest([run("actions", "2026-10-16T11:30:00.000Z")], NOW)).toBe(false);
    expect(shouldFallbackIngest([run("actions", "2026-10-16T11:59:00.000Z")], NOW)).toBe(false);
  });

  it("torna a raccogliere se la raccolta tace da più di due ore", () => {
    const limite = new Date(NOW.getTime() - FALLBACK_INGEST_AFTER_MS - 60_000).toISOString();
    expect(shouldFallbackIngest([run("actions", limite)], NOW)).toBe(true);
  });

  it("usa l'ultima raccolta, non la prima che trova", () => {
    const runs = [
      run("actions", "2026-10-16T11:45:00.000Z"),
      run("actions", "2026-10-16T06:00:00.000Z"),
    ];
    expect(shouldFallbackIngest(runs, NOW)).toBe(false);
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
