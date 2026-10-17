import { describe, expect, it } from "vitest";
import {
  balanceLines,
  boxState,
  exitCode,
  healthVerdict,
  kindVerdict,
  parseVitestSummary,
  renderBoxes,
  runVerdict,
  summaryLine,
  tempoFa,
  type Box,
  type Check,
  type HealthRow,
} from "../scripts/checklist.ts";
import type { RunRow } from "../src/types.ts";
import { ROBOTS_DENIED_REASON } from "../src/lib/robots.ts";

/**
 * La checklist di chiusura è un comando, ma il giudizio è nelle funzioni pure:
 * si provano senza toccare D1, senza rete e senza lanciare typecheck o suite.
 * Le righe qui sotto sono i casi che il README descrive — un 304 non è un
 * guasto, un 403 sì, una fonte di coupon senza coupon è da guardare.
 */

const NOW = new Date("2026-10-17T10:00:00.000Z");
const PRIMA = "2026-10-17T09:30:00.000Z";

function health(overrides: Partial<HealthRow> = {}): HealthRow {
  return {
    id: "scontrinofelice-cashback",
    lastStatus: 200,
    lastError: null,
    lastItems: 21,
    failStreak: 0,
    lastRunAt: PRIMA,
    lastOkAt: PRIMA,
    ...overrides,
  };
}

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    startedAt: PRIMA,
    trigger: "local",
    sourcesOk: 22,
    sourcesFail: 0,
    itemsNew: 3,
    ms: 9000,
    note: "local | 22 fonti | 3 duplicati",
    log: null,
    ...overrides,
  };
}

describe("healthVerdict", () => {
  it("200 con item è sano, e lo dice con le stesse parole di 📡 Fonti", () => {
    const esito = healthVerdict(health());
    expect(esito.state).toBe("ok");
    expect(esito.text).toContain("HTTP 200 · 21 item");
    expect(esito.text).toContain("fail_streak 0");
  });

  it("304 con zero item è sano: il feed non è cambiato, è lo stato di regime", () => {
    const esito = healthVerdict(health({ lastStatus: 304, lastItems: 0 }));
    expect(esito.state).toBe("ok");
    expect(esito.text).toContain("non è cambiata");
  });

  it("200 con zero item è sospetto, ma non è un guasto", () => {
    const esito = healthVerdict(health({ lastStatus: 200, lastItems: 0 }));
    expect(esito.state).toBe("warn");
    expect(esito.text).toContain("vuota");
  });

  it("403 è un fallimento: ha risposto, e ha risposto male", () => {
    const esito = healthVerdict(
      health({ lastStatus: 403, lastError: "HTTP 403", lastItems: 0, lastOkAt: "2026-10-16T09:00:00.000Z" }),
    );
    expect(esito.state).toBe("fail");
    expect(esito.text).toContain("HTTP 403");
  });

  it("fail_streak sopra zero fallisce anche quando l'ultimo tentativo è un 200", () => {
    const esito = healthVerdict(health({ failStreak: 2 }));
    expect(esito.state).toBe("fail");
    expect(esito.text).toContain("2 fallimenti di fila");
  });

  it("una fonte mai provata è da guardare, non rotta", () => {
    const esito = healthVerdict(
      health({ lastStatus: null, lastItems: 0, failStreak: 0, lastRunAt: null, lastOkAt: null }),
    );
    expect(esito.state).toBe("warn");
    expect(esito.text).toContain("mai provata");
  });

  it("robots.txt non è un guasto: la fonte resta sana con il suo 🚫", () => {
    const esito = healthVerdict(
      health({ lastStatus: null, lastError: ROBOTS_DENIED_REASON, lastItems: 0 }),
    );
    expect(esito.state).toBe("ok");
    expect(esito.text).toContain(ROBOTS_DENIED_REASON);
  });
});

describe("kindVerdict", () => {
  it("una fonte di offerte con coupon è coerente", () => {
    const esito = kindVerdict("coupon", { coupon: 21, contest: 3, news: 1 });
    expect(esito.state).toBe("ok");
    expect(esito.text).toContain("coupon 21 · contest 3 · news 1");
  });

  it("una fonte dichiarata coupon senza nemmeno un coupon è da guardare", () => {
    const esito = kindVerdict("coupon", { contest: 4, news: 2 });
    expect(esito.state).toBe("warn");
    expect(esito.text).toContain("senza coupon");
  });

  it("i coupon da una fonte che non è di offerte sono una categoria dichiarata male", () => {
    const esito = kindVerdict("concorsi", { contest: 10, coupon: 2 });
    expect(esito.state).toBe("warn");
    expect(esito.text).toContain("2 coupon");
  });

  it("nessun item in archivio non è una risposta: la prova dal vivo dice cosa ha letto", () => {
    const esito = kindVerdict("coupon", {});
    expect(esito.state).toBe("warn");
    expect(esito.text).toContain("nessun item");
  });
});

describe("runVerdict", () => {
  it("una raccolta esterna di mezz'ora fa ha lasciato la sua nota", () => {
    const esito = runVerdict([run()], NOW);
    expect(esito.state).toBe("ok");
    expect(esito.text).toContain("questo PC");
    expect(esito.text).toContain("30 min fa");
    expect(esito.details).toContain("local | 22 fonti | 3 duplicati");
  });

  it("un tick del Worker non è una raccolta: il log lo scrivono solo Actions e il PC", () => {
    const esito = runVerdict([run({ trigger: "*/15 * * * *" })], NOW);
    expect(esito.state).toBe("warn");
    expect(esito.text).toContain("nessuna raccolta esterna");
  });

  it("oltre due ore di silenzio il giro che stavi aspettando non è ancora passato", () => {
    const vecchia = run({ startedAt: "2026-10-17T07:00:00.000Z" });
    const esito = runVerdict([vecchia], NOW);
    expect(esito.state).toBe("warn");
    expect(esito.text).toContain("vecchia");
  });
});

describe("tempoFa", () => {
  it("scrive l'età in minuti, ore e giorni", () => {
    expect(tempoFa("2026-10-17T09:59:40.000Z", NOW)).toBe("adesso");
    expect(tempoFa("2026-10-17T09:40:00.000Z", NOW)).toBe("20 min fa");
    expect(tempoFa("2026-10-17T08:00:00.000Z", NOW)).toBe("2 ore fa");
    expect(tempoFa("2026-10-13T10:00:00.000Z", NOW)).toBe("4 giorni fa");
  });

  it("una data illeggibile non diventa un numero inventato", () => {
    expect(tempoFa("non-una-data", NOW)).toBe("data illeggibile");
  });
});

describe("balanceLines", () => {
  it("una riga per tipo, nell'ordine delle sezioni della chat", () => {
    const righe = balanceLines([
      { kind: "news", status: "new", n: 16 },
      { kind: "contest", status: "sent", n: 60 },
      { kind: "contest", status: "new", n: 34 },
      { kind: "coupon", status: "new", n: 66 },
    ]);
    expect(righe).toEqual([
      "contest (94): sent 60 · new 34",
      "coupon (66): new 66",
      "news (16): new 16",
    ]);
  });
});

describe("caselle e uscita", () => {
  const check = (state: Check["state"]): Check => ({ state, text: state });

  it("lo stato della casella è il peggiore dei suoi controlli", () => {
    expect(boxState([check("ok"), check("ok")])).toBe("ok");
    expect(boxState([check("ok"), check("warn")])).toBe("warn");
    expect(boxState([check("warn"), check("fail")])).toBe("fail");
    expect(boxState([check("ok"), check("todo")])).toBe("todo");
  });

  it("stampa una casella alla volta, con i suoi controlli e dettagli", () => {
    const boxes: Box[] = [
      {
        title: "1. Il codice regge",
        state: "ok",
        checks: [{ state: "ok", text: "typecheck — esce 0", details: ["una riga di dettaglio"] }],
      },
      { title: "4. La chat lo mostra", state: "todo", checks: [{ state: "todo", text: "a mano" }] },
    ];
    expect(renderBoxes(boxes)).toBe(
      [
        "[x] 1. Il codice regge",
        "      [x] typecheck — esce 0",
        "          una riga di dettaglio",
        "[-] 4. La chat lo mostra",
        "      [-] a mano",
      ].join("\n"),
    );
  });

  it("esce 1 solo se una casella non torna", () => {
    const box = (state: Box["state"]): Box => ({ title: state, state, checks: [] });
    expect(exitCode([box("ok"), box("warn"), box("todo")])).toBe(0);
    expect(exitCode([box("ok"), box("fail")])).toBe(1);
  });

  it("la riga finale conta le caselle per esito", () => {
    expect(
      summaryLine([
        { title: "1", state: "ok", checks: [] },
        { title: "2", state: "warn", checks: [] },
        { title: "3", state: "todo", checks: [] },
      ]),
    ).toBe("Caselle: [x] [!] [-] — 1 a posto, 1 da guardare, 0 non tornano, 1 a mano.");
  });
});

describe("parseVitestSummary", () => {
  it("legge i numeri del riepilogo di vitest, colori compresi", () => {
    const output = [
      "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m30 passed\u001b[39m\u001b[22m (30)",
      "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m618 passed\u001b[39m\u001b[22m (618)",
    ].join("\n");
    expect(parseVitestSummary(output)).toEqual({ tests: 618, failed: 0, files: 30 });
  });

  it("legge anche una suite con un test fallito", () => {
    const output = "Test Files  1 failed | 29 passed (30)\n     Tests  1 failed | 617 passed (618)";
    expect(parseVitestSummary(output)).toEqual({ tests: 617, failed: 1, files: 29 });
  });

  it("senza riepilogo non inventa numeri", () => {
    expect(parseVitestSummary("comando non partito")).toEqual({ tests: null, failed: null, files: null });
  });
});
