import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/db/memory.ts";
import { findDuplicate, isBetterTitle, prepareItem, toNewItem, upgradeTitle } from "../src/dedupe.ts";
import { enrichWithRules } from "../src/enrich/rules.ts";
import { baseScore } from "../src/enrich/score.ts";
import type { RawItem } from "../src/types.ts";

/**
 * La deduplica è il pezzo che tiene il bot informativo invece che rumoroso.
 * Questi test verificano la decisione finale (isDuplicateTitle) applicata
 * attraverso findDuplicate, compreso il caso che il solo SimHash sbaglierebbe.
 */

const NOW = new Date("2026-10-16T12:00:00.000Z");

function raw(title: string, url: string, summary = "", sourceId = "fonte-a"): RawItem {
  return { sourceId, url, title, summary, publishedAt: null, guid: null };
}

async function storeWith(item: RawItem, sourceName = "Aggregatore A") {
  const store = createMemoryStore();
  const prepared = await prepareItem(item, sourceName);
  const insight = enrichWithRules(item, { tags: [] }, NOW);
  const inserted = await store.insertItem(toNewItem(item, prepared, insight, baseScore(insight, item, NOW), NOW));
  return { store, prepared, inserted };
}

describe("prepareItem", () => {
  it("rimuove il nome della fonte anteposto dall'aggregatore", async () => {
    const prepared = await prepareItem(
      raw("Scontrino Felice - In palio una Fiat Panda con il concorso Barilla", "https://b.example/1"),
      "Scontrino Felice · concorsi con acquisto",
    );
    expect(prepared.title).toBe("In palio una Fiat Panda con il concorso Barilla");
  });

  it("non svuota il titolo se è fatto solo col nome della fonte", async () => {
    const prepared = await prepareItem(raw("Scontrino Felice", "https://b.example/2"), "Scontrino Felice");
    expect(prepared.title).toBe("Scontrino Felice");
  });

  it("canonicalizza l'URL e la chiave ignora i parametri di tracking", async () => {
    const clean = await prepareItem(raw("Concorso Barilla", "https://www.b.example/concorso-barilla/"));
    const tracciato = await prepareItem(
      raw("Concorso Barilla", "https://b.example/concorso-barilla?utm_source=telegram&fbclid=xyz"),
    );
    expect(clean.url).toBe("https://b.example/concorso-barilla");
    expect(tracciato.urlKey).toBe(clean.urlKey);
  });
});

describe("findDuplicate · decisione finale", () => {
  it("riconosce lo stesso concorso scritto in modo diverso da un'altra fonte", async () => {
    const { store } = await storeWith(
      raw("In palio una Fiat Panda con il concorso Barilla, scade il 25 ottobre 2026", "https://a.example/1"),
    );
    const candidate = await prepareItem(
      raw("Scontrino Felice - In palio una Fiat Panda con il concorso Barilla", "https://b.example/1", "", "fonte-b"),
      "Scontrino Felice · concorsi con acquisto",
    );
    const match = await findDuplicate(store, candidate, NOW);
    expect(match?.id).toBe(1);
  });

  it("riconosce il duplicato anche quando una fonte non indica l'importo", async () => {
    const { store } = await storeWith(raw("Concorso Findus: 1000 euro di buoni spesa", "https://a.example/2"));
    const candidate = await prepareItem(
      raw("Findus, concorso a premi: buoni spesa per la spesa", "https://b.example/2", "", "fonte-b"),
    );
    expect((await findDuplicate(store, candidate, NOW))?.id).toBe(1);
  });

  it("NON unisce concorsi diversi con lo stesso premio (Parigi/Nutella vs Kinder)", async () => {
    const { store } = await storeWith(raw("Concorso Nutella: vinci un viaggio a Parigi", "https://a.example/3"));
    const candidate = await prepareItem(raw("Vinci un viaggio a Parigi con il concorso Kinder", "https://b.example/3"));
    expect(await findDuplicate(store, candidate, NOW)).toBeNull();
  });

  it("NON unisce importi diversi dello stesso brand (1000 vs 500 euro)", async () => {
    const { store } = await storeWith(raw("Concorso Findus: 1000 euro di buoni spesa", "https://a.example/4"));
    const candidate = await prepareItem(raw("Concorso Findus: 500 euro di buoni spesa", "https://b.example/4"));
    expect(await findDuplicate(store, candidate, NOW)).toBeNull();
  });

  it("NON unisce lo stesso premio con brand diversi (Lidl vs Penny)", async () => {
    const { store } = await storeWith(raw("Vinci un buono spesa da 50 euro con Lidl", "https://a.example/5"));
    const candidate = await prepareItem(raw("Vinci un buono spesa da 50 euro con Penny", "https://b.example/5"));
    expect(await findDuplicate(store, candidate, NOW)).toBeNull();
  });

  it("riconosce l'URL identico anche se il titolo è stato riscritto", async () => {
    const { store } = await storeWith(raw("Concorso Barilla: vinci una Fiat Panda", "https://a.example/6"));
    const candidate = await prepareItem(raw("Titolo completamente diverso scritto dopo", "https://a.example/6"));
    expect((await findDuplicate(store, candidate, NOW))?.id).toBe(1);
  });
});

describe("il titolo migliore vince", () => {
  it("preferisce il titolo più completo a quello mozzo dello slug", () => {
    expect(isBetterTitle("Concorso Lievital", "Concorso Lievital: vinci Forni e Scaldavivande")).toBe(true);
    // Al contrario non si peggiora mai.
    expect(isBetterTitle("Concorso Lievital: vinci Forni e Scaldavivande", "Concorso Lievital")).toBe(false);
  });

  it("a parità di parole preferisce la forma scritta meglio", () => {
    expect(isBetterTitle("LA CACCIA AL TESORO DEL CAPITANO", "La Caccia al Tesoro del Capitano")).toBe(true);
    expect(isBetterTitle("La Caccia al Tesoro del Capitano", "LA CACCIA AL TESORO DEL CAPITANO")).toBe(false);
    expect(isBetterTitle("Concorso Barilla", "Concorso Barilla")).toBe(false);
  });

  it("non tocca un titolo quando il candidato è solo diverso", () => {
    expect(isBetterTitle("Vinci con Cupper", "Concorso Cupper a premi")).toBe(false);
    expect(isBetterTitle("Concorso Lidl: buoni spesa", "Vinci buoni spesa con Penny")).toBe(false);
  });

  it("aggiorna la riga in archivio con il titolo e la sua firma", async () => {
    // Il caso reale: la sitemap di Scontrino Felice usa lo slug, il feed il
    // titolo completo — e se capita prima la sitemap, in chat restava il mozzo.
    const { store, inserted } = await storeWith(
      raw("Concorso Lievital", "https://www.scontrinofelice.it/concorsi-con-acquisto/concorso-lievital/"),
    );
    const candidate = await prepareItem(
      raw(
        "Concorso Lievital: vinci Forni e Scaldavivande",
        "https://www.scontrinofelice.it/concorsi-con-acquisto/concorso-lievital/",
      ),
    );

    expect(await findDuplicate(store, candidate, NOW)).not.toBeNull();
    expect(await upgradeTitle(store, inserted.item, candidate)).toBe(true);

    const row = await store.getItem(inserted.item.id);
    expect(row?.title).toBe("Concorso Lievital: vinci Forni e Scaldavivande");
    expect(row?.simhash).toBe(candidate.simhash);
    // Un solo concorso in archivio: il duplicato non crea una seconda riga.
    expect(await store.queryItems({ limit: 10 })).toHaveLength(1);

    // E la seconda volta non riscrive niente (è già il titolo migliore).
    expect(await upgradeTitle(store, row!, candidate)).toBe(false);
  });
});
