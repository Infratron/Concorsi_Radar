import { describe, expect, it } from "vitest";
import type { SourceAttempt, SourceRow } from "../src/types.ts";
import { ROBOTS_DENIED_REASON } from "../src/lib/robots.ts";
import {
  esitoFonte,
  esitoUltimoTentativo,
  formatIngestReport,
  ingestLog,
  plainIngestLines,
  type IngestReport,
} from "../src/telegram/report.ts";

/**
 * Il racconto della raccolta: le parole con cui si dice "chi ha risposto e chi no".
 *
 * Il punto di questi test non è la formattazione in sé, ma la DISTINZIONE fra
 * esiti che a occhio si confondono: un 403 e un timeout sono due guasti diversi,
 * un 200 con zero item e un 304 non sono guasti affatto, e robots.txt non è né
 * l'uno né l'altro. Il racconto serve proprio a non doverlo dedurre a mano.
 *
 * Dove finisce: nel log dell'esecuzione (`runs.log`), che in chat si legge in
 * 🧾 Log delle raccolte. Non è più un messaggio mandato all'admin a ogni giro:
 * quello che si verifica qui è il testo, non l'invio (la lettura dalla chat ha i
 * suoi test in test/telegram.test.ts).
 */

function tentativo(partial: Partial<SourceAttempt> = {}): SourceAttempt {
  return {
    sourceId: "fonte-a",
    name: "Aggregatore A",
    at: "2026-10-16T10:03:00.000Z",
    httpStatus: 200,
    items: 5,
    notModified: false,
    robotsDenied: false,
    error: null,
    ...partial,
  };
}

function riga(partial: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "fonte-a",
    name: "Aggregatore A",
    kind: "rss",
    url: "https://a.example/feed",
    category: "online",
    tags: [],
    cadenceMin: 30,
    enabled: true,
    etag: null,
    lastModified: null,
    lastRunAt: "2026-10-16T10:03:00.000Z",
    lastOkAt: "2026-10-16T10:03:00.000Z",
    failStreak: 0,
    lastStatus: 200,
    lastError: null,
    lastItems: 5,
    ...partial,
  };
}

function report(attempts: SourceAttempt[], partial: Partial<IngestReport> = {}): IngestReport {
  return { attempts, itemsSeen: 5, itemsNew: 2, deferred: 0, titolo: "Prima raccolta su GitHub", ...partial };
}

describe("report · come si legge l'esito di una fonte", () => {
  it("un errore HTTP non si dice due volte", () => {
    const esito = esitoFonte({ httpStatus: 403, items: 0, notModified: false, robotsDenied: false, error: "HTTP 403" });
    expect(esito.emoji).toBe("🔴");
    expect(esito.motivo).toBe("HTTP 403");
    expect(esito.risposta).toBe(false);
  });

  it("una fonte che risponde e non porta niente non è una fonte rotta", () => {
    const vuota = esitoFonte({ httpStatus: 200, items: 0, notModified: false, robotsDenied: false, error: null });
    expect(vuota.emoji).toBe("🟢");
    expect(vuota.motivo).toBe("HTTP 200 · 0 item");
    expect(vuota.risposta).toBe(true);
    // ...e dice quanti item ha portato, al singolare quando è uno.
    expect(esitoFonte({ httpStatus: 200, items: 1, notModified: false, robotsDenied: false, error: null }).motivo)
      .toBe("HTTP 200 · 1 item");
  });

  it("una rete caduta non ha codice HTTP, e lo dice", () => {
    const esito = esitoFonte({
      httpStatus: null, items: 0, notModified: false, robotsDenied: false,
      error: "AbortError: The operation was aborted",
    });
    expect(esito.emoji).toBe("🔴");
    expect(esito.motivo).toBe("AbortError: The operation was aborted");
  });

  it("un errore di lettura a 200 porta anche il codice: il codice non è la spiegazione", () => {
    const esito = esitoFonte({
      httpStatus: 200, items: 0, notModified: false, robotsDenied: false, error: "parse: SyntaxError: unexpected token",
    });
    expect(esito.motivo).toBe("HTTP 200 · parse: SyntaxError: unexpected token");
    expect(esito.risposta).toBe(false);
  });

  it("un 304 è una risposta: la fonte c'è, è la pagina che non è cambiata", () => {
    const esito = esitoFonte({ httpStatus: 304, items: 0, notModified: true, robotsDenied: false, error: null });
    expect(esito.emoji).toBe("⚪️");
    expect(esito.motivo).toBe("HTTP 304 · non è cambiata");
    expect(esito.risposta).toBe(true);
  });

  it("su un archivio migrato non inventa uno zero: dice che il codice manca", () => {
    const esito = esitoFonte({ httpStatus: null, items: 0, notModified: false, robotsDenied: false, error: null });
    expect(esito.emoji).toBe("🟢");
    expect(esito.motivo).toBe("ok, codice non registrato");
    expect(esito.motivo).not.toContain("item");
  });

  it("robots.txt è una porta chiusa, non un guasto della fonte", () => {
    const esito = esitoFonte({ httpStatus: null, items: 0, notModified: false, robotsDenied: true, error: null });
    expect(esito.emoji).toBe("🚫");
    expect(esito.motivo).toBe(ROBOTS_DENIED_REASON);
    expect(esito.risposta).toBe(false);
  });
});

describe("report · l'esito letto dall'archivio", () => {
  it("distingue l'ultimo tentativo dall'ultimo successo", () => {
    const riuscita = esitoUltimoTentativo(riga());
    expect(riuscita.emoji).toBe("🟢");
    expect(riuscita.motivo).toBe("HTTP 200 · 5 item");

    const fallita = esitoUltimoTentativo(
      riga({ failStreak: 2, lastStatus: 503, lastError: "HTTP 503", lastOkAt: "2026-10-15T10:03:00.000Z", lastItems: 0 }),
    );
    expect(fallita.emoji).toBe("🔴");
    expect(fallita.motivo).toBe("HTTP 503");

    const saltata = esitoUltimoTentativo(riga({ lastError: ROBOTS_DENIED_REASON, lastStatus: null, lastItems: 0 }));
    expect(saltata.emoji).toBe("🚫");
    // Non è un fallimento: il tentativo è "riuscito", è la lettura che non è permessa.
    expect(saltata.risposta).toBe(false);
  });
});

describe("report · il testo del log", () => {
  it("mette davanti chi NON ha risposto, con ora e codice", () => {
    const testo = formatIngestReport(
      report([
        tentativo(),
        tentativo({ sourceId: "fonte-b", name: "Scontrino Felice", httpStatus: 403, items: 0, error: "HTTP 403" }),
        tentativo({ sourceId: "fonte-c", name: "Soldissimi", httpStatus: 304, items: 0, notModified: true }),
      ]),
    ) ?? "";

    expect(testo).toContain("Prima raccolta su GitHub</b> · 12:03");
    expect(testo).toContain("3 fonti provate, <b>2 hanno risposto</b>, 1 no · 5 item letti, 2 nuovi");
    expect(testo.indexOf("Non hanno risposto")).toBeLessThan(testo.indexOf("Hanno risposto"));
    expect(testo).toContain("🔴 Scontrino Felice · HTTP 403");
    expect(testo).toContain("🟢 Aggregatore A · HTTP 200 · 5 item");
    expect(testo).toContain("⚪️ Soldissimi · HTTP 304 · non è cambiata");
  });

  it("non lascia passare HTML dai nomi, e dice quante fonti sono rimaste indietro", () => {
    const testo = formatIngestReport(
      report([tentativo({ name: "Sito <b>finto</b> & co" })], { deferred: 2 }),
    ) ?? "";
    expect(testo).toContain("&lt;b&gt;finto&lt;/b&gt;");
    expect(testo).not.toContain("<b>finto</b>");
    expect(testo).toContain("2 fonti rimandate al giro successivo");
  });

  it("senza fonti provate non c'è niente da raccontare, né in chat né su GitHub", () => {
    expect(formatIngestReport(report([]))).toBeNull();
    expect(plainIngestLines(report([]))).toEqual([]);
  });

  it("le righe per la pagina di GitHub sono in testo semplice", () => {
    const righe = plainIngestLines(
      report([tentativo({ name: "Vincimi" }), tentativo({ name: "Soldissimi", httpStatus: 403, error: "HTTP 403" })]),
    );
    expect(righe).toEqual(["- 🟢 **Vincimi** · HTTP 200 · 5 item", "- 🔴 **Soldissimi** · HTTP 403"]);
  });
});

describe("report · il log che si salva con l'esecuzione", () => {
  it("è il racconto del giro, con le note della pipeline in fondo", () => {
    // Il log non è una seconda formattazione del report: è lo STESSO testo, più le
    // note del giro (una fonte morta, un tetto raggiunto). Tenerli in un posto
    // solo è il motivo per cui sono cresciuti insieme.
    const log = ingestLog(
      report([tentativo(), tentativo({ name: "Scontrino Felice", httpStatus: 403, error: "HTTP 403" })]),
      ["soldissimi: HTTP 429"],
    ) ?? "";

    expect(log).toContain("Prima raccolta su GitHub</b> · 12:03");
    expect(log).toContain("🔴 Scontrino Felice · HTTP 403");
    expect(log).toContain("⚠️ <b>Note del giro</b>");
    expect(log).toContain("• soldissimi: HTTP 429");
  });

  it("senza note il log resta il solo racconto delle fonti", () => {
    const log = ingestLog(report([tentativo()])) ?? "";
    expect(log).toContain("Aggregatore A");
    expect(log).not.toContain("Note del giro");
  });

  it("un giro senza fonti provate non produce un log (meglio nulla che un guscio)", () => {
    expect(ingestLog(report([]))).toBeNull();
  });

  it("le note non possono iniettare HTML nel log, come i nomi delle fonti", () => {
    const log = ingestLog(report([tentativo()]), ["fonte <b>x</b> & co"]) ?? "";
    expect(log).toContain("fonte &lt;b&gt;x&lt;/b&gt; &amp; co");
    expect(log).not.toContain("<b>x</b>");
  });
});
