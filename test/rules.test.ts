import { describe, expect, it } from "vitest";
import { candidatesForRules, patchFor, textRuleFor } from "../scripts/backfill-rules.ts";
import type { ItemRow } from "../src/types.ts";

/**
 * Il riempimento dei regolamenti (`npm run rules -- --apply`).
 *
 * Serve perché la raccolta cerca il bando solo per i concorsi NUOVI e solo per
 * MAX_RULES_LOOKUPS_PER_RUN pagine a giro: l'archivio raccolto prima di questa
 * funzione, e la coda di un giro affollato, li prende questo comando. La
 * selezione è una funzione pura, quindi si prova senza database e senza eseguire
 * il comando — come per il riempimento delle marche.
 */

function riga(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 1,
    sourceId: "premieconcorsi",
    brand: null,
    kind: "contest",
    rulesUrl: null,
    url: "https://esempio.it/concorso/1",
    urlKey: "key-1",
    simhash: "0123456789abcdef",
    title: "Concorso esempio",
    summary: "",
    publishedAt: null,
    firstSeenAt: "2026-11-20T08:00:00.000Z",
    lastSeenAt: "2026-11-20T08:00:00.000Z",
    deadline: null,
    prize: null,
    participation: null,
    prizeValue: 0.5,
    effort: 0.5,
    requiresPurchase: false,
    tags: [],
    score: 50,
    clusterId: null,
    status: "new",
    aiUsed: false,
    ...overrides,
  };
}

describe("riempimento · chi ha un bando da cercare", () => {
  it("prende i concorsi attivi senza regolamento, e lascia stare gli altri", () => {
    const concorso = riga({ id: 1 });
    const coupon = riga({ id: 2, kind: "coupon", sourceId: "scontrinofelice-coupon" });
    const articolo = riga({ id: 3, kind: "news" });
    const giaTrovato = riga({ id: 4, rulesUrl: "https://esempio.it/bando.pdf" });
    const chiuso = riga({ id: 5, status: "expired" });
    const scartato = riga({ id: 6, status: "ignored" });
    const vinto = riga({ id: 7, status: "won" });

    expect(candidatesForRules([concorso, coupon, articolo, giaTrovato, chiuso, scartato, vinto]).map((row) => row.id)).toEqual([1]);
  });

  it("un concorso in watchlist resta un candidato: il bando serve a chi partecipa", () => {
    expect(candidatesForRules([riga({ id: 1, status: "saved" }), riga({ id: 2, status: "sent" })]).map((row) => row.id)).toEqual([1, 2]);
  });

  it("il bando scritto nel testo si legge gratis, senza aprire la pagina", () => {
    expect(textRuleFor(riga({ summary: "Regolamento su https://esempio.it/bando.pdf" }))).toBe(
      "https://esempio.it/bando.pdf",
    );
    // Il bando può stare anche in "come partecipare": è la stessa estrazione
    // della scheda in chat, quindi vale anche qui.
    expect(textRuleFor(riga({ participation: "Vedi https://esempio.it/regolamento/" }))).toBe(
      "https://esempio.it/regolamento/",
    );
    expect(textRuleFor(riga({ summary: "Partecipa con lo scontrino." }))).toBeNull();
    // Un link alla pagina stessa non è un bando: la ricerca sulla pagina va fatta.
    expect(textRuleFor(riga({ url: "https://esempio.it/concorso", summary: "https://esempio.it/concorso" }))).toBeNull();
  });
});

describe("riempimento · bando e scadenza dalla stessa pagina", () => {
  it("aggiunge quello che manca, corregge con la riga Scadenza, non cancella niente", () => {
    // Senza bando né scadenza: la pagina li porta tutti e due.
    expect(patchFor(riga(), { rulesUrl: "https://esempio.it/bando.pdf", deadline: { deadline: "2026-11-20", explicit: false } }))
      .toEqual({ rulesUrl: "https://esempio.it/bando.pdf", deadline: "2026-11-20" });
    // Una data d'inizio scambiata per scadenza: la riga "Scadenza :" la corregge.
    expect(patchFor(riga({ deadline: "2027-02-02" }), { rulesUrl: null, deadline: { deadline: "2026-11-29", explicit: true } }))
      .toEqual({ deadline: "2026-11-29" });
    // Un intervallo della pagina non tocca una scadenza che c'è già.
    expect(patchFor(riga({ deadline: "2026-11-18" }), { rulesUrl: null, deadline: { deadline: "2026-11-26", explicit: false } })).toEqual({});
    // Un bando già salvato resta quello, e una pagina muta non toglie niente.
    expect(patchFor(riga({ rulesUrl: "https://a.it/vecchio.pdf", deadline: "2026-12-01" }), { rulesUrl: "https://a.it/nuovo.pdf", deadline: null })).toEqual({});
  });
});
