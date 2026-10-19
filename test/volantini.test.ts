import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/db/memory.ts";
import { FLYER_REFRESH_MS, flyerDates, flyerValidity, isNewFlyer, parseFlyerPage, refreshFlyers, type FlyerSource } from "../src/volantini.ts";
import { accoppiate } from "../src/negozi.ts";
import type { FetchLike, ItemRow } from "../src/types.ts";

/**
 * 📰 Volantini e 🤝 accoppiate: le date si leggono come le scrivono le catene
 * (le frasi qui sono quelle delle pagine vere del 19/10/2026), e una pagina che
 * non risponde non cancella il volantino che c'era.
 */

const NOW = new Date("2026-10-19T08:00:00.000Z");

describe("📰 le date dei volantini", () => {
  it("legge le formule delle catene vere", () => {
    // MD
    expect(flyerDates("Volantino dal 6 al 18 Ottobre 2026", NOW)).toEqual({ from: "2026-10-06", to: "2026-10-18" });
    // Eurospin: due mesi
    expect(flyerDates("Dal 22 ottobre al 1 novembre 2026", NOW)).toEqual({ from: "2026-10-22", to: "2026-11-01" });
    // Despar: senza anno, vale quello di oggi
    expect(flyerDates("Dal 19 ottobre al 16 novembre", NOW)).toEqual({ from: "2026-10-19", to: "2026-11-16" });
    // Lidl: le date nell'indirizzo
    expect(flyerDates("/l/it/volantini/offerte-valide-dall1-10-al-31-10-da-lidl", NOW)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("a cavallo d'anno la fine è dell'anno dopo, e il rumore non è una data", () => {
    expect(flyerDates("dal 28 dicembre al 6 gennaio", NOW)).toEqual({ from: "2026-12-28", to: "2027-01-06" });
    expect(flyerDates("Scopri le offerte del momento", NOW)).toBeNull();
    // Il 31 febbraio non esiste: niente date inventate.
    expect(flyerDates("dal 3 al 31 febbraio", NOW)).toBeNull();
  });

  it("dice se il volantino è in corso, in arrivo, superato o senza date", () => {
    expect(flyerValidity({ validFrom: "2026-10-01", validTo: "2026-10-31" }, NOW)).toBe("in-corso");
    expect(flyerValidity({ validFrom: "2026-10-22", validTo: "2026-11-01" }, NOW)).toBe("in-arrivo");
    expect(flyerValidity({ validFrom: "2026-10-06", validTo: "2026-10-18" }, NOW)).toBe("scaduto");
    expect(flyerValidity({ validFrom: null, validTo: null }, NOW)).toBe("senza-date");
    // L'ultimo giorno è ancora valido.
    expect(flyerValidity({ validFrom: null, validTo: "2026-10-19" }, NOW)).toBe("in-corso");
  });

  it("fra più volantini nella pagina sceglie quello in corso, e il settimanale prima del mensile", () => {
    const lidl: FlyerSource = {
      id: "lidl",
      page: "https://www.lidl.it/c/volantino-lidl/s10018048",
      linkPattern: /https:\/\/www\.lidl\.it\/l\/it\/volantini\/offerte-valide[^"'\s<>]+/,
      scelta: "volantino",
    };
    // Le due forme vere della pagina Lidl, nell'ordine "sbagliato".
    const html = `<a href="https://www.lidl.it/l/it/volantini/offerte-valide-dall1-10-al-31-10-da-lidl/ar/0">mese</a>
      <a href="https://www.lidl.it/l/it/volantini/offerte-valide-dal-15-10-al-21-10-volantino-settimanale/ar/65">settimana</a>
      <a href="https://www.lidl.it/l/it/volantini/offerte-valide-dal-22-10-al-28-10-prossima/ar/66">dopo</a>`;
    expect(parseFlyerPage(lidl, html, lidl.page, NOW)).toMatchObject({
      url: "https://www.lidl.it/l/it/volantini/offerte-valide-dal-15-10-al-21-10-volantino-settimanale/ar/65",
      validFrom: "2026-10-15",
      validTo: "2026-10-21",
    });
  });

  it("dalla pagina prende il link del volantino, le date e la copertina", () => {
    const lidl: FlyerSource = {
      id: "lidl",
      page: "https://www.lidl.it/c/volantino-lidl/s10018048",
      linkPattern: /https:\/\/www\.lidl\.it\/l\/it\/volantini\/offerte-valide[^"'\s<>]+/,
      scelta: "volantino",
    };
    const html = `<meta property="og:image" content="https://www.lidl.it/copertina.jpg">
      <a href="https://www.lidl.it/l/it/volantini/offerte-valide-dall1-10-al-31-10-da-lidl/ar/0">Sfoglia</a>`;
    expect(parseFlyerPage(lidl, html, lidl.page, NOW)).toEqual({
      url: "https://www.lidl.it/l/it/volantini/offerte-valide-dall1-10-al-31-10-da-lidl/ar/0",
      validFrom: "2026-10-01",
      validTo: "2026-10-31",
      coverUrl: "https://www.lidl.it/copertina.jpg",
    });
    // Senza link più preciso il volantino è la pagina, con le date del testo.
    const md: FlyerSource = { id: "md", page: "https://www.mdspa.it/volantino/", scelta: "volantino" };
    expect(parseFlyerPage(md, "<p>Valido <b>dal 6 al 18 Ottobre 2026</b></p>", md.page, NOW)).toMatchObject({
      url: "https://www.mdspa.it/volantino/",
      validTo: "2026-10-18",
    });
  });
});

describe("📰 la rilettura dei volantini", () => {
  const fonte: FlyerSource = { id: "md", page: "https://www.mdspa.it/volantino/", scelta: "volantino" };

  function rete(pagina: () => Response) {
    const chiamate: string[] = [];
    const fetcher: FetchLike = async (input) => {
      chiamate.push(String(input));
      if (String(input).endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      return pagina();
    };
    return { fetcher, chiamate };
  }

  it("salva il volantino, non lo rilegge prima di dodici ore, e segna quando cambia", async () => {
    const store = createMemoryStore();
    let html = "<p>dal 6 al 18 Ottobre 2026</p>";
    const { fetcher, chiamate } = rete(() => new Response(html, { status: 200 }));
    const deps = { store, fetcher, userAgent: "test" };

    // La prima lettura salva, ma non è un "nuovo volantino".
    expect(await refreshFlyers(deps, NOW, [fonte])).toEqual({ checked: 1, changed: 0, failed: [] });
    const [primo] = await store.listFlyers();
    expect(primo).toMatchObject({ chain: "md", validTo: "2026-10-18", changedAt: null, status: 200 });
    expect(isNewFlyer(primo!, NOW)).toBe(false);

    // Un'ora dopo: niente richieste.
    const pagine = chiamate.filter((url) => !url.endsWith("robots.txt")).length;
    await refreshFlyers(deps, new Date(NOW.getTime() + 3_600_000), [fonte]);
    expect(chiamate.filter((url) => !url.endsWith("robots.txt")).length).toBe(pagine);

    // Dodici ore dopo, stesso volantino: riletto, ma non "nuovo".
    const dopo = new Date(NOW.getTime() + FLYER_REFRESH_MS + 1);
    expect((await refreshFlyers(deps, dopo, [fonte])).changed).toBe(0);
    expect((await store.listFlyers())[0]?.changedAt).toBeNull();

    // Volantino nuovo: cambia la data, e il cambio si segna.
    html = "<p>dal 20 al 31 Ottobre 2026</p>";
    const ancora = new Date(dopo.getTime() + FLYER_REFRESH_MS + 1);
    expect((await refreshFlyers(deps, ancora, [fonte])).changed).toBe(1);
    const nuovo = (await store.listFlyers())[0]!;
    expect(nuovo.validTo).toBe("2026-10-31");
    expect(isNewFlyer(nuovo, ancora)).toBe(true);
    expect(isNewFlyer(nuovo, new Date(ancora.getTime() + 4 * 86_400_000))).toBe(false);
  });

  it("una pagina che non risponde lascia il volantino di prima", async () => {
    const store = createMemoryStore();
    await store.saveFlyer({
      chain: "md", url: "https://www.mdspa.it/volantino/", validFrom: "2026-10-06", validTo: "2026-10-18",
      coverUrl: null, checkedAt: "2026-10-01T00:00:00.000Z", changedAt: "2026-10-01T00:00:00.000Z", status: 200,
    });
    const { fetcher } = rete(() => new Response("errore", { status: 503 }));
    const esito = await refreshFlyers({ store, fetcher, userAgent: "test" }, NOW, [fonte]);
    expect(esito.failed).toEqual(["md"]);
    expect((await store.listFlyers())[0]).toMatchObject({ validTo: "2026-10-18", status: 503, checkedAt: NOW.toISOString() });
  });

  it("rispetta robots.txt: una pagina vietata non si legge", async () => {
    const store = createMemoryStore();
    const chiamate: string[] = [];
    const fetcher: FetchLike = async (input) => {
      chiamate.push(String(input));
      if (String(input).endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /volantino/", { status: 200 });
      return new Response("<p>dal 6 al 18 Ottobre 2026</p>", { status: 200 });
    };
    expect((await refreshFlyers({ store, fetcher, userAgent: "test" }, NOW, [fonte])).failed).toEqual(["md"]);
    expect(chiamate.some((url) => url.includes("/volantino/"))).toBe(false);
    expect(await store.listFlyers()).toEqual([]);
  });
});

describe("🤝 accoppiate", () => {
  let id = 0;
  const item = (kind: "coupon" | "contest", title: string, extra: Partial<ItemRow> = {}): ItemRow =>
    ({
      id: ++id, kind, title, brand: null, requiresPurchase: kind === "contest", summary: "", url: `https://x.it/${id}`,
      score: 50, tags: [], ...extra,
    }) as ItemRow;

  it("mette insieme l'offerta e il concorso della stessa marca, anche fuori registro", () => {
    const gruppi = accoppiate([
      item("coupon", "Cashback Dash e Fairy: richiedi 5 Euro di rimborso"),
      item("contest", "Concorso Dash: vinci 1 anno di bucato"),
      item("coupon", "Buono sconto Crema Novi Fondente: 1,50€ gratis"),
      item("contest", "Vinci X Factor 2026 con Crema Novi"),
      // Senza la controparte non è un'accoppiata.
      item("coupon", "Cashback Ymea: richiedi 25 euro di rimborso"),
      // Un concorso gratuito non chiede la stessa spesa.
      item("contest", "Concorso Ymea online", { requiresPurchase: false }),
    ]);
    expect(gruppi.map((g) => g.marca).sort()).toEqual(["Crema Novi", "Dash"]);
    const dash = gruppi.find((g) => g.marca === "Dash")!;
    expect(dash.offerte).toHaveLength(1);
    expect(dash.concorsi).toHaveLength(1);
  });

  it("le parole da promozione, i negozi e le parole troppo comuni non fanno un'accoppiata", () => {
    const comuni = Array.from({ length: 5 }, (_, n) => item("coupon", `Cashback Bontà numero ${n}`));
    const gruppi = accoppiate([
      item("coupon", "Cashback Scottex Esselunga: acquista 2 prodotti"),
      item("contest", "Raccolta bollini Esselunga XFactor"),
      item("coupon", "Rimborso Speciale autunno"),
      item("contest", "Concorso Speciale autunno"),
      ...comuni,
      item("contest", "Concorso Bontà a premi"),
    ]);
    expect(gruppi).toEqual([]);
  });

  it("usa la marca del registro quando c'è", () => {
    const gruppi = accoppiate([
      item("coupon", "Buono sconto da 1 euro", { brand: "barilla" }),
      item("contest", "Vinci una cucina", { brand: "barilla" }),
    ]);
    expect(gruppi.map((g) => g.marca)).toEqual(["Barilla"]);
  });
});
