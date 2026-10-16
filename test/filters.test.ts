import { describe, expect, it } from "vitest";
import { SOURCES } from "../src/config/sources.ts";
import {
  CATEGORY_LABELS,
  STAR_CHOICES,
  TAG_FILTERS,
  activeFilterCount,
  categoriesToOffer,
  defaultFilters,
  filterChangeLabel,
  filterableSources,
  filtersFor,
  isSeeingAll,
  mutedSourceIds,
  parseFilters,
  starLabel,
  withFilterChange,
} from "../src/filters.ts";

/**
 * I filtri personali di una chat.
 * La proprietà che conta più di tutte: sono ESCLUSIONI, quindi chi non ha mai
 * toccato niente vede tutto — anche le fonti aggiunte dopo.
 */

describe("filtri · impostazione predefinita", () => {
  it("una chat senza filtri vede tutto", () => {
    const filters = defaultFilters();
    expect(isSeeingAll(filters)).toBe(true);
    expect(activeFilterCount(filters)).toBe(0);
    expect(mutedSourceIds(filters)).toEqual([]);
    expect(filtersFor(filters, { kinds: ["contest"] })).toEqual({ kinds: ["contest"] });
  });

  it("i filtri di default sono una copia: mutarli non tocca la costante", () => {
    const filters = defaultFilters();
    filters.mutedTags.push("food");
    expect(defaultFilters().mutedTags).toEqual([]);
  });

  it("una fonte nuova e accesa è visibile a chi non ha mai filtrato", () => {
    // È il motivo per cui i filtri sono esclusioni e non inclusioni.
    for (const source of filterableSources()) {
      expect(mutedSourceIds(defaultFilters())).not.toContain(source.id);
    }
  });
});

describe("filtri · categorie", () => {
  it("spegnere una categoria spegne tutte le fonti che la dichiarano", () => {
    const filters = { ...defaultFilters(), mutedCategories: ["scontrino" as const] };
    const spenti = mutedSourceIds(filters);
    const scontrino = SOURCES.filter((source) => source.category === "scontrino").map((source) => source.id);
    expect(scontrino.length).toBeGreaterThan(0);
    expect([...spenti].sort()).toEqual([...scontrino].sort());
  });

  it("somma le fonti spente una per una a quelle spente per categoria", () => {
    const filters = {
      ...defaultFilters(),
      mutedCategories: ["giftcard" as const],
      mutedSources: ["vincimi"],
    };
    const spenti = mutedSourceIds(filters);
    expect(spenti).toContain("vincimi");
    expect(spenti).toContain("soldissimi"); // categoria giftcard
    expect(new Set(spenti).size).toBe(spenti.length); // nessun doppione
  });

  it("offre solo le categorie che esistono davvero fra le fonti accese", () => {
    const offerte = categoriesToOffer();
    expect(offerte.length).toBeGreaterThan(0);
    for (const categoria of offerte) {
      expect(SOURCES.some((source) => source.enabled && source.category === categoria)).toBe(true);
      expect(CATEGORY_LABELS[categoria]).toBeDefined();
    }
    // Una categoria senza fonti accese non si mostra: filtrare il nulla è rumore.
    for (const categoria of Object.keys(CATEGORY_LABELS)) {
      const accese = SOURCES.filter((source) => source.enabled && source.category === categoria).length;
      if (accese === 0) expect(offerte).not.toContain(categoria);
    }
  });
});

describe("filtri · tipi di concorso", () => {
  it("i tipi offerti sono tag che le regole assegnano davvero", () => {
    // Non deve comparire la marca ("ferrero") né il meccanismo di raccolta
    // ("sitemap"): sono metadati della fonte, non un tipo di concorso.
    const tags = TAG_FILTERS.map((entry) => entry.tag);
    expect(tags).toContain("raccolta_punti");
    expect(tags).not.toContain("sitemap");
    expect(tags).not.toContain("brand");
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("spegne e riaccende un tipo con lo stesso tocco", () => {
    const primo = withFilterChange(defaultFilters(), { kind: "tag", value: "raccolta_punti" });
    expect(primo.mutedTags).toEqual(["raccolta_punti"]);
    expect(activeFilterCount(primo)).toBe(1);
    const secondo = withFilterChange(primo, { kind: "tag", value: "raccolta_punti" });
    expect(secondo.mutedTags).toEqual([]);
  });
});

describe("filtri · stelle minime", () => {
  it("alza la soglia della query, senza mai abbassarla", () => {
    const query = filtersFor({ ...defaultFilters(), minScore: 70 }, { minScore: 80 });
    expect(query.minScore).toBe(80);
    expect(filtersFor({ ...defaultFilters(), minScore: 70 }, {}).minScore).toBe(70);
    expect(filtersFor(defaultFilters(), { minScore: 60 }).minScore).toBe(60);
  });

  it("conta come filtro attivo e si spegne tornando a tutte", () => {
    const alzata = withFilterChange(defaultFilters(), { kind: "star", value: 70 });
    expect(alzata.minScore).toBe(70);
    expect(activeFilterCount(alzata)).toBe(1);
    expect(isSeeingAll(alzata)).toBe(false);
    expect(withFilterChange(alzata, { kind: "star", value: 0 }).minScore).toBe(0);
    expect(isSeeingAll(withFilterChange(alzata, { kind: "star", value: 0 }))).toBe(true);
  });

  it("accetta solo le soglie offerte: un valore inventato diventa \"tutte\"", () => {
    expect(withFilterChange(defaultFilters(), { kind: "star", value: 95 }).minScore).toBe(0);
    expect(STAR_CHOICES).toEqual([0, 70, 80]);
    expect(starLabel(0)).toContain("Tutte");
    expect(starLabel(70)).toBe("⭐ 70+");
  });
});

describe("filtri · traduzione in query", () => {
  it("solo-gratis diventa un vincolo sull'acquisto, non sull'elenco dei tag", () => {
    const filters = { ...defaultFilters(), freeOnly: true };
    const query = filtersFor(filters, { statuses: ["new"] });
    expect(query.withoutPurchase).toBe(true);
    expect(query.excludeTags).toBeUndefined();
    expect(query.statuses).toEqual(["new"]);
  });

  it("somma le esclusioni a quelle già presenti nella query", () => {
    const filters = { ...defaultFilters(), mutedSources: ["vincimi"], mutedTags: ["food"] };
    const query = filtersFor(filters, { excludeSources: ["altro"], excludeTags: ["auto"] });
    expect(query.excludeSources).toEqual(["altro", "vincimi"]);
    expect(query.excludeTags).toEqual(["auto", "food"]);
  });

  it("non aggiunge campi quando non c'è niente da escludere", () => {
    const query = filtersFor(defaultFilters(), { limit: 6 });
    expect(query).toEqual({ limit: 6 });
  });

  it("non muta la query originale", () => {
    const originale = { excludeSources: ["a"] };
    filtersFor({ ...defaultFilters(), mutedSources: ["b"] }, originale);
    expect(originale.excludeSources).toEqual(["a"]);
  });
});

describe("filtri · lettura dal database", () => {
  it("rilegge quello che ha scritto", () => {
    const filters = {
      mutedSources: ["vincimi"],
      mutedCategories: ["giftcard" as const],
      mutedTags: ["food"],
      freeOnly: true,
      minScore: 75,
    };
    expect(parseFilters(JSON.stringify(filters))).toEqual(filters);
  });

  it("un valore rovinato non rompe niente: si torna a vedere tutto", () => {
    expect(parseFilters("{non-json")).toEqual(defaultFilters());
    expect(parseFilters(null)).toEqual(defaultFilters());
    expect(parseFilters("[]")).toEqual(defaultFilters());
    expect(parseFilters(JSON.stringify({ mutedTags: "food", freeOnly: "sì" }))).toEqual(defaultFilters());
  });

  it("una soglia di stelle assurda torna a zero", () => {
    expect(parseFilters(JSON.stringify({ minScore: 500 })).minScore).toBe(0);
    expect(parseFilters(JSON.stringify({ minScore: -10 })).minScore).toBe(0);
    expect(parseFilters(JSON.stringify({ minScore: "80" })).minScore).toBe(0);
    expect(parseFilters(JSON.stringify({ minScore: 80 })).minScore).toBe(80);
  });

  it("scarta categorie inesistenti e doppioni", () => {
    const filters = parseFilters(
      JSON.stringify({ mutedCategories: ["giftcard", "inventata", "giftcard"], mutedTags: ["food", "food"] }),
    );
    expect(filters.mutedCategories).toEqual(["giftcard"]);
    expect(filters.mutedTags).toEqual(["food"]);
  });
});

describe("filtri · conferma del tocco", () => {
  it("dice sempre cosa è successo", () => {
    const filters = { ...defaultFilters(), mutedTags: ["food"] };
    const etichetta = (change: Parameters<typeof filterChangeLabel>[1]): string =>
      filterChangeLabel(filters, change, (id) => `Nome di ${id}`);
    expect(etichetta({ kind: "tag", value: "food" })).toContain("🚫");
    expect(etichetta({ kind: "tag", value: "viaggio" })).toContain("✅");
    expect(etichetta({ kind: "source", value: "vincimi" })).toBe("✅ Nome di vincimi");
    expect(etichetta({ kind: "category", value: "giftcard" })).toBe(`✅ ${CATEGORY_LABELS.giftcard}`);
    expect(etichetta({ kind: "free", value: true })).toBe("🎁 Solo senza acquisto");
    expect(etichetta({ kind: "free", value: false })).toContain("acquisto");
    expect(etichetta({ kind: "reset" })).toContain("tutto");
  });
});
