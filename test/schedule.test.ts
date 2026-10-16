import { describe, expect, it } from "vitest";
import {
  COLLECTION_REMINDER_GAP_MS,
  COLLECTION_REMINDER_MARK,
  COLLECTION_REMINDER_SKIP,
  COLLECTION_SILENCE_MS,
  DIGEST_CRONS,
  EXTERNAL_TRIGGERS,
  FALLBACK_INGEST_AFTER_MS,
  NOTIFY_CRON,
  collectionCheck,
  isDigestWindow,
  isExternalTrigger,
  jobFor,
  runOrigin,
  shouldFallbackIngest,
} from "../src/schedule.ts";
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
    return { startedAt, trigger, sourcesOk: 0, sourcesFail: 0, itemsNew: 0, ms: 0, note: null, log: null };
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

describe("collectionCheck · il promemoria quando la raccolta è ferma", () => {
  const NOW = new Date("2026-10-16T12:00:00.000Z");
  /** Una riga di `runs` come la scrive il Worker, ore prima di NOW. */
  function run(trigger: string, oreFa: number, note: string | null = null): RunRow {
    return {
      startedAt: new Date(NOW.getTime() - oreFa * 3_600_000).toISOString(),
      trigger,
      sourcesOk: 1,
      sourcesFail: 0,
      itemsNew: 0,
      ms: 100,
      note,
      log: null,
    };
  }
  const tick = (oreFa: number, note: string | null = null) => run(NOTIFY_CRON, oreFa, note);

  it("con una raccolta recente non c'è niente da dire", () => {
    const esito = collectionCheck([tick(0.25), run("actions", 1)], NOW);
    expect(esito.ferma).toBe(false);
    expect(esito.avvisare).toBe(false);
    expect(esito.oreDaRaccolta).toBe(1);
  });

  it("scatta dopo tre ore di silenzio, anche se i tick del Worker girano", () => {
    const esito = collectionCheck([tick(0.25), tick(0.5), run("actions", 3.5)], NOW);
    expect(esito.ferma).toBe(true);
    expect(esito.avvisare).toBe(true);
    expect(esito.oreDaRaccolta).toBe(3.5);
    expect(esito.oreDalTick).toBe(0.25);
  });

  it("esattamente sulla soglia non avvisa ancora", () => {
    const esito = collectionCheck([tick(0), run("actions", COLLECTION_SILENCE_MS / 3_600_000)], NOW);
    expect(esito.ferma).toBe(false);
  });

  it("se la raccolta non è mai girata lo dice, senza inventare una data", () => {
    // Solo tick del Worker: la finestra copre dalle 6 ore fa in poi.
    const esito = collectionCheck([tick(0.25), tick(6)], NOW);
    expect(esito.ferma).toBe(true);
    expect(esito.oreDaRaccolta).toBeNull();
    expect(esito.finestraOre).toBe(6);
    expect(esito.avvisare).toBe(true);
  });

  it("non ripete il promemoria prima della distanza minima", () => {
    const appena = collectionCheck([tick(0.25), run("actions", 4, COLLECTION_REMINDER_MARK)], NOW);
    expect(appena.ferma).toBe(true);
    expect(appena.ripetuto).toBe(true);
    expect(appena.avvisare).toBe(false);
  });

  it("resta zitto appena dentro la distanza minima, e riparte appena fuori", () => {
    const gap = COLLECTION_REMINDER_GAP_MS / 3_600_000;
    const dentro = collectionCheck([tick(0.25), run("actions", gap - 0.1, COLLECTION_REMINDER_MARK)], NOW);
    expect(dentro.ripetuto).toBe(true);
    expect(dentro.avvisare).toBe(false);

    const fuori = collectionCheck([tick(0.25), run("actions", gap + 0.1, COLLECTION_REMINDER_MARK)], NOW);
    expect(fuori.ripetuto).toBe(false);
    expect(fuori.avvisare).toBe(true);
  });

  it("una nota che dice di NON aver avvisato non vale come promemoria inviato", () => {
    // È la trappola che questo test difende: il tick scrive una nota a ogni giro,
    // quindi cercare "promemoria raccolta" e basta renderebbe l'avviso unico.
    const esito = collectionCheck([tick(0.25, COLLECTION_REMINDER_SKIP), run("actions", 5)], NOW);
    expect(esito.ripetuto).toBe(false);
    expect(esito.avvisare).toBe(true);
  });
});

describe("la raccolta esterna: GitHub o il PC, non conta quale", () => {
  const NOW = new Date("2026-10-16T12:00:00.000Z");
  function run(trigger: string, oreFa: number, note: string | null = null): RunRow {
    return {
      startedAt: new Date(NOW.getTime() - oreFa * 3_600_000).toISOString(),
      trigger,
      sourcesOk: 0,
      sourcesFail: 0,
      itemsNew: 0,
      ms: 100,
      note,
      log: null,
    };
  }

  it("i due esecutori del progetto sono raccolte esterne; un cron no", () => {
    expect([...EXTERNAL_TRIGGERS]).toEqual(["actions", "local"]);
    expect(isExternalTrigger("actions")).toBe(true);
    expect(isExternalTrigger("local")).toBe(true);
    expect(isExternalTrigger(NOTIFY_CRON)).toBe(false);
  });

  it("una raccolta recente dal PC tiene il Worker fuori dai feed", () => {
    // È il caso reale di questa installazione: GitHub Actions non gira, la
    // raccolta la lancia `npm run ingest` dalla macchina di chi usa il bot.
    expect(shouldFallbackIngest([run("local", 0.5)], NOW)).toBe(false);
    expect(shouldFallbackIngest([run("local", 3)], NOW)).toBe(true);
  });

  it("il promemoria della raccolta ferma legge anche le esecuzioni locali", () => {
    const tick = run(NOTIFY_CRON, 0.25);
    const locale = collectionCheck([tick, run("local", 1)], NOW);
    expect(locale.ferma).toBe(false);
    expect(locale.oreDaRaccolta).toBe(1);

    const fermo = collectionCheck([tick, run("local", 4)], NOW);
    expect(fermo.ferma).toBe(true);
    expect(fermo.avvisare).toBe(true);
  });

  it("ogni esecuzione si racconta con il suo nome", () => {
    expect(runOrigin("actions")).toBe("GitHub");
    expect(runOrigin("local")).toBe("questo PC");
    expect(runOrigin(NOTIFY_CRON)).toBe("Worker");
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
