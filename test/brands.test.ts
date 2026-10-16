import { describe, expect, it } from "vitest";
import { BRANDS, brandChoices, brandFor, brandIds, brandLabel, brandOrder, isBrandId } from "../src/config/brands.ts";
import { SOURCES } from "../src/config/sources.ts";
import { selectBrandChanges } from "../scripts/backfill-brands.ts";
import type { ItemRow } from "../src/types.ts";

/**
 * Il registro delle marche e il riconoscimento.
 *
 * Due cose si verificano qui, e sono quelle che si rompono in silenzio:
 *  1. che una marca si riconosca da tutte e due le strade (la fonte e il testo),
 *     perché un concorso Kinder ripreso da un aggregatore non ha nessun tag
 *     "ferrero" addosso;
 *  2. che NON si riconosca dove non c'è: le parole si confrontano come token
 *     interi, quindi "aia" non deve pescare "baia" e "mulino" da solo non è
 *     Mulino Bianco.
 */

describe("marche · registro", () => {
  it("gli id sono unici e ogni marca ha almeno una parola", () => {
    const ids = brandIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const brand of BRANDS) {
      expect(brand.id).toBe(brand.id.toLowerCase());
      expect(brand.words.length).toBeGreaterThan(0);
      expect(brand.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("valida gli id e sa dire il nome di una marca", () => {
    expect(isBrandId("ferrero")).toBe(true);
    expect(isBrandId("marca-inventata")).toBe(false);
    expect(isBrandId("")).toBe(false);
    expect(brandLabel("ferrero")).toBe("Ferrero");
    // Uno slug sconosciuto resta se stesso invece di sparire dal messaggio.
    expect(brandLabel("marca-inventata")).toBe("marca-inventata");
  });

  it("tutte le fonti di marca portano a una marca del registro", () => {
    // Il legame fonte → marca si ricava dai tag della configurazione: se una
    // fonte di marca ha un tag che non è nel registro, la sua marca non esiste.
    const diMarca = SOURCES.filter((source) => source.enabled && source.tags.includes("brand"));
    expect(diMarca.length).toBeGreaterThan(0);
    for (const source of diMarca) {
      // Le due fonti di brand "generiche" (le news e il template) non sono di una
      // marca sola: per loro l'unica strada è il testo.
      if (source.id === "news-brand" || source.id === "brand-sitemap-template") continue;
      expect(brandFor({ sourceId: source.id, title: "Promozione" })).not.toBeNull();
    }
  });
});

describe("marche · riconoscimento dalla fonte", () => {
  it("la marca di una fonte di brand non dipende dal titolo", () => {
    // La pagina di un brand non sempre nomina se stessa nell'URL: la sitemap
    // Ferrero pubblica "/promozioni/…", e il titolo è ricavato dallo slug.
    expect(brandFor({ sourceId: "sitemap-ferrero", title: "Promozione estate" })).toBe("ferrero");
    expect(brandFor({ sourceId: "sitemap-conad", title: "Colleziona i bollini" })).toBe("conad");
    expect(brandFor({ sourceId: "cocacola-offerte", title: "Offerta" })).toBe("cocacola");
  });

  it("una fonte non di marca non porta nessuna marca da sola", () => {
    expect(brandFor({ sourceId: "premieconcorsi", title: "Concorso senza nomi" })).toBeNull();
    expect(brandFor({ sourceId: "news-brand", title: "Tutti i concorsi del mese" })).toBeNull();
  });
});

describe("marche · riconoscimento dal testo", () => {
  it("trova la marca nel titolo, anche con le sotto-marche", () => {
    expect(brandFor({ sourceId: "premieconcorsi", title: "Concorso Nutella: vinci 1000 euro" })).toBe("ferrero");
    expect(brandFor({ sourceId: "premieconcorsi", title: "Concorso Kinder con i pupazzi" })).toBe("ferrero");
    expect(brandFor({ sourceId: "premieconcorsi", title: "Vinci una bici con Barilla" })).toBe("barilla");
  });

  it("legge la marca anche scritta con il trattino o dal sommario", () => {
    expect(brandFor({ sourceId: "premieconcorsi", title: "Coca-Cola mette in palio 1000 biglietti" })).toBe("cocacola");
    expect(brandFor({ sourceId: "premieconcorsi", title: "coca cola: in palio" })).toBe("cocacola");
    expect(
      brandFor({ sourceId: "news-instantwin", title: "In palio un viaggio", summary: "L'operazione è di Esselunga." }),
    ).toBe("esselunga");
    // L'URL è una prova come le altre: le sitemap dei brand mettono la marca lì.
    expect(brandFor({ sourceId: "sitemap-generica", url: "https://www.conad.it/collezioni-e-concorsi/ferrari" })).toBe("conad");
  });

  it("le parole si confrontano intere, non come pezzi di parola", () => {
    expect(brandFor({ sourceId: "premieconcorsi", title: "Vinci un soggiorno in una baia della Sardegna" })).toBeNull();
    // "mulino" da solo non è Mulino Bianco: servono tutti i token della parola.
    expect(brandFor({ sourceId: "premieconcorsi", title: "Visita al mulino del paese" })).toBeNull();
    expect(brandFor({ sourceId: "premieconcorsi", title: "Concorso Mulino Bianco" })).toBe("mulinobianco");
  });

  it("una parola italiana comune non fa diventare marca un concorso", () => {
    // "aia" e "baia": AIA si riconosce dal dominio (aiafood.com), non dal nome.
    expect(brandFor({ sourceId: "premieconcorsi", title: "Un weekend in aia con la fattoria" })).toBeNull();
    expect(brandFor({ sourceId: "premieconcorsi", url: "https://www.aiafood.com/it/concorsi/x" })).toBe("aia");
  });

  it("un testo senza marche resta senza marca", () => {
    expect(brandFor({ sourceId: "premieconcorsi", title: "", summary: "", url: "" })).toBeNull();
    expect(brandFor({ sourceId: "premieconcorsi", title: "Concorso a premi per tutti" })).toBeNull();
  });
});

/** Riga d'archivio minima: al riempimento servono fonte, titolo, sommario e URL. */
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

describe("marche · riempimento dell'archivio", () => {
  it("scrive solo le marche riconosciute che non sono già in riga", () => {
    const changes = selectBrandChanges([
      riga({ id: 1, title: "Concorso Nutella" }),
      // Già riconosciuta: non si riscrive.
      riga({ id: 2, title: "Concorso Nutella", brand: "ferrero" }),
      // Nessuna marca riconoscibile: resta senza, non si inventa niente.
      riga({ id: 3, title: "Concorso a premi per tutti" }),
    ]);
    expect(changes).toEqual([{ id: 1, title: "Concorso Nutella", from: null, to: "ferrero" }]);
  });

  it("riconosce la marca anche dalla fonte, come fa l'ingestione", () => {
    const changes = selectBrandChanges([riga({ id: 9, sourceId: "sitemap-conad", title: "Colleziona i bollini" })]);
    expect(changes).toEqual([{ id: 9, title: "Colleziona i bollini", from: null, to: "conad" }]);
  });
});

describe("marche · ordine nella schermata", () => {
  it("prima le marche che hanno concorsi in archivio", () => {
    const ordine = brandOrder({ conad: 3, ferrero: 12, barilla: 1 });
    expect(ordine.slice(0, 3)).toEqual(["ferrero", "conad", "barilla"]);
    // Tutte le marche restano in elenco, una volta ciascuna: il registro intero
    // è raggiungibile, si sposta solo l'ordine.
    expect(ordine).toHaveLength(BRANDS.length);
    expect(new Set(ordine).size).toBe(BRANDS.length);
  });

  it("le marche senza concorsi stanno in fondo, in ordine alfabetico", () => {
    const ordine = brandOrder({});
    const etichette = ordine.map((id) => brandLabel(id));
    expect(etichette).toEqual([...etichette].sort((a, b) => a.localeCompare(b, "it")));
  });

  it("costruisce le voci della schermata con conteggio e stato", () => {
    const scelte = brandChoices({ ferrero: 7 }, ["conad"]);
    expect(scelte[0]).toEqual({ id: "ferrero", label: "Ferrero", count: 7, followed: false });
    // Una marca seguita senza concorsi in archivio resta nell'elenco, con zero.
    const conad = scelte.find((scelta) => scelta.id === "conad");
    expect(conad).toEqual({ id: "conad", label: "Conad", count: 0, followed: true });
  });
});
