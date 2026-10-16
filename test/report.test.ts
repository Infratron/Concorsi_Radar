import { describe, expect, it } from "vitest";
import type { SourceAttempt, SourceRow } from "../src/types.ts";
import type { TelegramClient } from "../src/telegram/api.ts";
import { ROBOTS_DENIED_REASON } from "../src/lib/robots.ts";
import {
  esitoFonte,
  esitoUltimoTentativo,
  formatIngestReport,
  plainIngestLines,
  sendIngestReport,
  type IngestReport,
} from "../src/telegram/report.ts";

/**
 * Il report della raccolta: le parole con cui si dice "chi ha risposto e chi no".
 *
 * Il punto di questi test non è la formattazione in sé, ma la DISTINZIONE fra
 * esiti che a occhio si confondono: un 403 e un timeout sono due guasti diversi,
 * un 200 con zero item e un 304 non sono guasti affatto, e robots.txt non è né
 * l'uno né l'altro. Il report serve proprio a non doverlo dedurre da un log.
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

function fakeTg(): { tg: TelegramClient; sent: { chatId: number; text: string }[] } {
  const sent: { chatId: number; text: string }[] = [];
  const tg = {
    async sendMessage(chatId: number, text: string) {
      sent.push({ chatId, text });
      return { ok: true, messageId: 1, error: null, retryAfter: null };
    },
  } as unknown as TelegramClient;
  return { tg, sent };
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

describe("report · il messaggio", () => {
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

  it("senza fonti provate non c'è nessun messaggio da mandare", () => {
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

describe("report · l'invio", () => {
  it("manda all'admin il messaggio con tutte le fonti", async () => {
    const { tg, sent } = fakeTg();
    const inviato = await sendIngestReport({
      tg,
      chatId: 42,
      report: report([tentativo(), tentativo({ name: "Scontrino Felice", httpStatus: 403, error: "HTTP 403" })]),
    });
    expect(inviato).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(42);
    expect(sent[0]?.text).toContain("Scontrino Felice");
  });

  it("senza un admin con cui parlare non manda niente (e non fallisce)", async () => {
    const { tg, sent } = fakeTg();
    expect(await sendIngestReport({ tg, chatId: null, report: report([tentativo()]) })).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
