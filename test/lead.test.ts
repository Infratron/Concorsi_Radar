import { describe, expect, it } from "vitest";
import { SOURCES } from "../src/config/sources.ts";
import {
  CHANNEL_BY_SOURCE,
  channelOf,
  leadHours,
  primaVistaPerCanale,
  sightingFor,
  summarizeLead,
} from "../src/enrich/lead.ts";
import type { Sighting } from "../src/types.ts";

/**
 * Il vantaggio di tempistica, provato senza database: le viste sono righe scritte
 * a mano e il calcolo è una funzione pura.
 *
 * La cosa che questi test difendono: i concorsi visti da una sola classe di canale
 * NON valgono zero. Sono censurati — per loro il confronto non esiste — e contarli
 * come pareggio (o peggio, buttarli dentro la media) è il modo più facile per
 * raccontarsi che siamo veloci.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z");

function vista(partial: Partial<Sighting> & { itemId: number; sourceId: string; seenAt: string }): Sighting {
  return {
    urlKey: `key-${partial.itemId}`,
    kind: "contest",
    channel: channelOf(partial.sourceId),
    kept: true,
    ...partial,
  };
}

describe("lead · canali", () => {
  it("ogni fonte configurata ha un canale dichiarato", () => {
    const configurate = SOURCES.map((source) => source.id);
    for (const id of configurate) {
      expect(CHANNEL_BY_SOURCE[id], `fonte senza canale: ${id}`).toBeDefined();
    }
  });

  it("non tiene righe per fonti che non esistono più", () => {
    const configurate = new Set(SOURCES.map((source) => source.id));
    const orfane = Object.keys(CHANNEL_BY_SOURCE).filter((id) => !configurate.has(id));
    expect(orfane).toEqual([]);
  });

  it("un id sconosciuto resta fuori dal confronto", () => {
    // `stampa` è il canale che non entra né nel lato diretto né in quello degli
    // aggregatori: una fonte non classificata non deve poter falsare il numero.
    expect(channelOf("fonte-mai-vista")).toBe("stampa");
    expect(channelOf("sitemap-conad")).toBe("brand");
    expect(channelOf("scontrinofelice-acquisto")).toBe("aggregatore");
    expect(channelOf("news-scontrino")).toBe("stampa");
  });

  it("costruisce la vista con il canale già risolto", () => {
    const riga = sightingFor({
      urlKey: "key-1",
      sourceId: "sitemap-conad",
      itemId: 7,
      kind: "contest",
      kept: true,
      now: NOW,
    });
    expect(riga).toEqual({
      urlKey: "key-1",
      sourceId: "sitemap-conad",
      itemId: 7,
      kind: "contest",
      channel: "brand",
      seenAt: NOW.toISOString(),
      kept: true,
    });
  });
});

describe("lead · anticipo di un concorso", () => {
  it("è positivo quando la fonte diretta è arrivata prima", () => {
    const ore = leadHours([
      vista({ itemId: 1, sourceId: "premieconcorsi", seenAt: "2026-11-20T08:00:00.000Z" }),
      vista({ itemId: 1, sourceId: "sitemap-conad", seenAt: "2026-11-20T02:00:00.000Z" }),
    ]);
    expect(ore).toBe(6);
  });

  it("senza uno dei due canali non c'è anticipo da calcolare", () => {
    expect(leadHours([vista({ itemId: 1, sourceId: "sitemap-conad", seenAt: "2026-11-20T02:00:00.000Z" })])).toBeNull();
    expect(leadHours([vista({ itemId: 1, sourceId: "soldissimi", seenAt: "2026-11-20T02:00:00.000Z" })])).toBeNull();
  });

  it("tiene la vista più antica di ogni canale, anche con più copie", () => {
    const prima = primaVistaPerCanale([
      vista({ itemId: 1, sourceId: "premieconcorsi", seenAt: "2026-11-20T09:00:00.000Z" }),
      vista({ itemId: 1, sourceId: "vincimi", seenAt: "2026-11-20T05:00:00.000Z" }),
      vista({ itemId: 1, sourceId: "sitemap-conad", seenAt: "2026-11-20T07:00:00.000Z" }),
      vista({ itemId: 1, sourceId: "sitemap-ferrero", seenAt: "2026-11-20T03:00:00.000Z" }),
    ]);
    expect(prima.aggregatore).toBe(Date.parse("2026-11-20T05:00:00.000Z"));
    expect(prima.brand).toBe(Date.parse("2026-11-20T03:00:00.000Z"));
    expect(prima.brandDa).toBe("sitemap-ferrero");
    expect(prima.aggregatoreDa).toBe("vincimi");
  });

  it("le viste scartate non contano", () => {
    const ore = leadHours([
      vista({ itemId: 1, sourceId: "premieconcorsi", seenAt: "2026-11-20T08:00:00.000Z" }),
      vista({ itemId: 1, sourceId: "sitemap-conad", seenAt: "2026-11-20T02:00:00.000Z", kept: false }),
    ]);
    expect(ore).toBeNull();
  });
});

describe("lead · statistiche della finestra", () => {
  /**
   * Cinque concorsi, uno per situazione: sei ore prima, dodici ore dopo, stesso
   * giro, e i due casi in cui il confronto non esiste.
   */
  const VISTE: Sighting[] = [
    // Concorso 1: noi prima di 6 ore.
    vista({ itemId: 1, sourceId: "sitemap-conad", seenAt: "2026-11-20T02:00:00.000Z" }),
    vista({ itemId: 1, sourceId: "premieconcorsi", seenAt: "2026-11-20T08:00:00.000Z" }),
    // Concorso 2: l'aggregatore prima di 12 ore.
    vista({ itemId: 2, sourceId: "sitemap-eni", seenAt: "2026-11-20T19:00:00.000Z" }),
    vista({ itemId: 2, sourceId: "soldissimi", seenAt: "2026-11-20T07:00:00.000Z" }),
    // Concorso 3: stesso giro di raccolta.
    vista({ itemId: 3, sourceId: "sitemap-ferrero", seenAt: "2026-11-20T06:00:00.000Z" }),
    vista({ itemId: 3, sourceId: "vincimi", seenAt: "2026-11-20T06:00:00.000Z" }),
    // Concorso 4: solo fonti dirette.
    vista({ itemId: 4, sourceId: "sitemap-conad", seenAt: "2026-11-20T04:00:00.000Z" }),
    // Concorso 5: solo aggregatori.
    vista({ itemId: 5, sourceId: "dimmicosacerchi", seenAt: "2026-11-20T04:30:00.000Z" }),
    // Concorso 6: visto e scartato: non entra in nessun conteggio.
    vista({ itemId: 6, sourceId: "sitemap-lavazza", seenAt: "2026-11-20T03:00:00.000Z", kept: false }),
  ];

  it("separa i confrontabili dai due casi censurati", () => {
    const stats = summarizeLead(VISTE, NOW);
    expect(stats.concorsi).toBe(5);
    expect(stats.confrontabili).toBe(3);
    expect(stats.avanti).toBe(1);
    expect(stats.dietro).toBe(1);
    expect(stats.insieme).toBe(1);
    expect(stats.soloDiretti).toBe(1);
    expect(stats.soloAggregatori).toBe(1);
  });

  it("dà mediana e quartili dei solo confrontabili", () => {
    const stats = summarizeLead(VISTE, NOW);
    // Delta ordinati: -12, 0, +6. Mediana 0; quartili interpolati -6 e +3.
    expect(stats.medianaOre).toBe(0);
    expect(stats.p25Ore).toBe(-6);
    expect(stats.p75Ore).toBe(3);
  });

  it("conta le fasce solo per i casi in cui eravamo avanti", () => {
    const stats = summarizeLead(VISTE, NOW);
    // Sei ore è già la seconda fascia: la prima è \"entro 6 ore\" strette.
    expect(stats.fasce).toEqual({ entro6h: 0, entroGiorno: 1, entro3giorni: 0, oltre: 0 });
  });

  it("dice da quanti giorni stiamo misurando", () => {
    expect(summarizeLead(VISTE, NOW).daGiorni).toBe(1);
    expect(summarizeLead([], NOW).daGiorni).toBe(0);
    expect(summarizeLead([], NOW).concorsi).toBe(0);
  });

  it("senza confrontabili le statistiche restano vuote, non zero", () => {
    const stats = summarizeLead(
      [vista({ itemId: 1, sourceId: "sitemap-conad", seenAt: "2026-11-20T04:00:00.000Z" })],
      NOW,
    );
    expect(stats.confrontabili).toBe(0);
    expect(stats.medianaOre).toBeNull();
    expect(stats.p25Ore).toBeNull();
    expect(stats.soloDiretti).toBe(1);
  });
});
