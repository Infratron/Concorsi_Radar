import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/db/memory.ts";
import { extractDeadline, extractParticipation, extractPrize, extractTags, enrichWithRules } from "../src/enrich/rules.ts";
import { SCORE_WEIGHTS, applyBrandBonus, applyWeights, baseScore, explainScore, rescoreRow, scoreItem } from "../src/enrich/score.ts";
import { MAX_NEURONS_PER_DAY, enrichWithAi, mergeInsight, needsAi } from "../src/enrich/ai.ts";
import type { AiBinding, Insight, RawItem } from "../src/types.ts";

const NOW = new Date("2026-10-16T12:00:00.000Z");

describe("estrazione della scadenza", () => {
  it("legge una data con il mese scritto e l'anno esplicito", () => {
    expect(extractDeadline("Il concorso scade il 30 novembre 2026", NOW)).toBe("2026-11-30");
  });

  it("legge una data numerica", () => {
    expect(extractDeadline("Partecipa entro il 15/12/2026", NOW)).toBe("2026-12-15");
  });

  it("inferisce l'anno quando manca", () => {
    expect(extractDeadline("Partecipa entro il 15 dicembre", NOW)).toBe("2026-12-15");
  });

  it("accetta l'anno a due cifre", () => {
    expect(extractDeadline("Scade il 05/01/27", NOW)).toBe("2027-01-05");
  });

  it("sceglie la data di chiusura quando il testo cita anche l'inizio", () => {
    expect(extractDeadline("Il concorso è partito il 1 ottobre e si chiude il 30 novembre 2026", NOW)).toBe("2026-11-30");
  });

  it("scarta le date impossibili", () => {
    expect(extractDeadline("Scade il 31/02/2026", NOW)).toBeNull();
  });

  it("scarta le scadenze già passate", () => {
    expect(extractDeadline("Il concorso si è chiuso il 10/01/2026", NOW)).toBeNull();
  });

  it("non scambia un importo per una data", () => {
    expect(extractDeadline("In palio 1.000 euro di buoni spesa", NOW)).toBeNull();
  });

  it("restituisce null quando non c'è alcuna data", () => {
    expect(extractDeadline("Concorso senza indicazioni", NOW)).toBeNull();
  });
});

describe("estrazione del premio", () => {
  it("riconosce gift card e ne stima il valore alto", () => {
    const { prize, prizeValue } = extractPrize("In palio una gift card da 500 euro");
    expect(prize).toContain("gift card");
    expect(prizeValue).toBeGreaterThanOrEqual(0.9);
  });

  it("riconosce un'auto dalla marca, senza la parola auto", () => {
    expect(extractPrize("In palio una Fiat Panda per te").prizeValue).toBe(1);
  });

  it("stima alto un premio in contanti consistente", () => {
    expect(extractPrize("In palio 2000 euro in contanti").prizeValue).toBeGreaterThanOrEqual(0.85);
  });

  it("stima basso un gadget", () => {
    expect(extractPrize("In palio gadget e campioni omaggio").prizeValue).toBeLessThanOrEqual(0.3);
  });

  it("senza indizi tiene un valore prudente e nessun testo premio", () => {
    const { prize, prizeValue } = extractPrize("Concorso generico senza dettagli sui premi");
    expect(prize).toBeNull();
    expect(prizeValue).toBe(0.3);
  });
});

describe("partecipazione e sforzo", () => {
  it("un concorso gratuito senza acquisto risulta a sforzo massimo", () => {
    const result = extractParticipation("Concorso gratuito senza obbligo di acquisto, basta iscriversi al sito");
    expect(result.requiresPurchase).toBe(false);
    expect(result.effort).toBe(1);
    expect(result.participation).not.toBeNull();
  });

  it("uno scontrino abbassa lo sforzo e segnala l'acquisto", () => {
    const result = extractParticipation("Serve lo scontrino di acquisto da conservare");
    expect(result.requiresPurchase).toBe(true);
    expect(result.effort).toBeLessThan(0.5);
    expect(result.participation).toContain("acquisto");
  });

  it("un elaborato da inviare abbassa lo sforzo", () => {
    expect(extractParticipation("Invia una foto del tuo piatto preferito").effort).toBeLessThan(0.5);
  });
});

describe("tag", () => {
  it("riconosce gift card, buoni spesa e gratis", () => {
    const tags = extractTags("In palio una gift card e buoni spesa, concorso gratuito senza obbligo");
    expect(tags).toContain("giftcard");
    expect(tags).toContain("buoni_spesa");
    expect(tags).toContain("gratis");
  });

  it("riconosce la raccolta punti", () => {
    expect(extractTags("Raccolta punti Esselunga: in palio una e-bike")).toContain("raccolta_punti");
  });

  it("riconosce il premio da richiedere, che non arriva da solo", () => {
    // Le formule del bando, comprese quelle in cui il premio è plurale o è un
    // buono: "premi richiedibili entro il…", "riscatta il premio in cassa".
    expect(extractTags("Premi richiedibili entro il 30 novembre")).toContain("premio_da_richiedere");
    expect(extractTags("Sconto riscattabile: riscatta il premio in cassa")).toContain("premio_da_richiedere");
    expect(extractTags("Raccolta punti Scottex e Scottonelle: richiedi premi Ariete")).toContain(
      "premio_da_richiedere",
    );

    // E i titoli veri delle raccolte in archivio il 16/10/2026, riga per riga:
    // il tag c'è dove il premio si richiede, e NON c'è dove i premi si
    // collezionano e basta. La direzione dell'errore è quella dichiarata —
    // meglio nessun tag che un tag inventato.
    const vere: [string, boolean][] = [
      ["Raccolta punti Premiati con il mondo del pulito: richiedi Buoni Amazon, Carburante e Shopping", true],
      ["Raccolta bollini DPiù Bellissima: richiedi i premi Imetec", true],
      ["Raccolta bollini Arcaplanet: colleziona i peluche “La Carica dei Cuccioli”", false],
      ["Raccolta bollini Famila, Italmark, Il Gigante, A&O, Galassia: colleziona premi FILA", false],
      ["Raccolta punti Italmark Friends: scopri tutti i premi da collezionare", false],
      ["Raccolta bollini Bennet Guzzini: scopri tutti i premi", false],
      ["Nuova Raccolta Punti Divella “La Passione che ti Premia”: richiedi la biscottiera e la coppa", false],
      // Un'estrazione normale, dove il premio lo manda l'organizzatore.
      ["Concorso Barilla: vinci una Fiat Panda", false],
      // Un rimborso: "richiedi 25 euro" non è un premio da riscattare.
      ["Cashback Ymea: richiedi 25 euro di rimborso", false],
    ];
    for (const [titolo, atteso] of vere) {
      expect({ titolo, tag: extractTags(titolo).includes("premio_da_richiedere") }).toEqual({ titolo, tag: atteso });
    }
  });

  it("non inventa tag su un testo neutro", () => {
    expect(extractTags("Comunicato stampa dell'azienda")).toEqual([]);
  });
});

describe("enrichWithRules", () => {
  it("unisce i tag della fonte a quelli del testo", () => {
    const item: RawItem = {
      sourceId: "soldissimi", url: "https://x/1", guid: null, publishedAt: null,
      title: "In palio una gift card Amazon da 100 euro",
      summary: "Concorso gratuito, scade il 30 novembre 2026, senza obbligo di acquisto.",
    };
    const insight = enrichWithRules(item, { tags: ["giftcard", "news"] }, NOW);
    expect(insight.deadline).toBe("2026-11-30");
    expect(insight.requiresPurchase).toBe(false);
    expect(insight.tags).toContain("news");
    expect(insight.tags).toContain("gratis");
    expect(insight.aiUsed).toBe(false);
  });

  it("aggiunge il tag acquisto quando serve lo scontrino", () => {
    const item: RawItem = {
      sourceId: "x", url: "https://x/2", guid: null, publishedAt: null,
      title: "Concorso Findus", summary: "Partecipa con lo scontrino: acquisto obbligatorio.",
    };
    expect(enrichWithRules(item, { tags: [] }, NOW).tags).toContain("acquisto");
  });
});

function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    deadline: null, prize: null, participation: null, prizeValue: 0.5, effort: 0.5,
    requiresPurchase: false, tags: [], aiUsed: false, ...overrides,
  };
}

describe("punteggio", () => {
  it("premia un premio alto, gratuito e in scadenza", () => {
    const alto = baseScore(
      insight({ prizeValue: 1, effort: 1, deadline: "2026-10-20" }),
      { title: "In palio una Fiat Panda", summary: "Concorso gratuito", publishedAt: NOW.toISOString() },
      NOW,
    );
    const basso = baseScore(
      insight({ prizeValue: 0.2, effort: 0.1, deadline: "2027-06-30", requiresPurchase: true }),
      { title: "Gadget omaggio", summary: "", publishedAt: NOW.toISOString() },
      NOW,
    );
    expect(alto).toBeGreaterThan(basso + 30);
  });

  it("dà più punti a una scadenza imminente che a una lontana", () => {
    const vicina = baseScore(insight({ deadline: "2026-10-18" }), { title: "Concorso Esselunga", summary: "x" }, NOW);
    const lontana = baseScore(insight({ deadline: "2027-01-30" }), { title: "Concorso Esselunga", summary: "x" }, NOW);
    // Solo la scadenza entro 3 giorni prende il bonus pieno; la lontana nessuno.
    expect(vicina - lontana).toBe(SCORE_WEIGHTS.deadlineSoon);
  });

  it("penalizza le scadenze passate", () => {
    const scaduta = baseScore(insight({ deadline: "2026-10-10" }), { title: "Concorso Esselunga", summary: "x" }, NOW);
    const senza = baseScore(insight({ deadline: null }), { title: "Concorso Esselunga", summary: "x" }, NOW);
    expect(scaduta).toBeLessThan(senza);
  });

  it("applica i pesi appresi e resta nei limiti 0-100", () => {
    expect(applyWeights(50, ["giftcard"], { giftcard: 3 })).toBe(59);
    expect(applyWeights(50, ["giftcard"], { giftcard: -5 })).toBe(35);
    expect(applyWeights(99, ["giftcard"], { giftcard: 5 })).toBe(100);
    expect(applyWeights(2, ["giftcard"], { giftcard: -5 })).toBe(0);
  });

  it("ignora i pesi non numerici o assenti", () => {
    expect(applyWeights(50, ["giftcard"], {})).toBe(50);
    expect(applyWeights(50, [], { giftcard: 5 })).toBe(50);
  });

  it("scoreItem somma punteggio base e pesi", () => {
    const base = baseScore(insight(), { title: "Concorso Esselunga", summary: "x" }, NOW);
    expect(scoreItem(insight(), { title: "Concorso Esselunga", summary: "x" }, { giftcard: 0 }, NOW)).toBe(base);
  });

  it("la marca seguita vale dieci punti, solo se la segui", () => {
    const esselunga = { title: "Concorso Esselunga", summary: "x", brand: "esselunga" };
    const senza = scoreItem(insight(), esselunga, {}, NOW);
    expect(scoreItem(insight(), esselunga, {}, NOW, ["esselunga"])).toBe(senza + SCORE_WEIGHTS.favoriteBrand);
    // Un'altra marca seguita non cambia niente: il bonus è della SUA marca.
    expect(scoreItem(insight(), esselunga, {}, NOW, ["ferrero"])).toBe(senza);
    // Un concorso senza marca riconosciuta non prende niente da nessuno.
    expect(scoreItem(insight(), { title: "Concorso", summary: "x", brand: null }, {}, NOW, ["ferrero"])).toBe(
      scoreItem(insight(), { title: "Concorso", summary: "x" }, {}, NOW),
    );
    // Il tetto resta 100, e il conto non sfonda.
    expect(applyBrandBonus(95, "ferrero", ["ferrero"])).toBe(100);
    expect(applyBrandBonus(50, null, ["ferrero"])).toBe(50);
  });

  it("il ricalcolo di una riga d'archivio rifà lo stesso conto dell'ingestione", () => {
    // È la funzione che accende una marca sui concorsi già in archivio: parte
    // dai campi della riga, quindi il punteggio di prima viene sostituito, non
    // sommato a una differenza tenuta a mente.
    const riga = {
      id: 1,
      sourceId: "sitemap-ferrero",
      brand: "ferrero",
      kind: "contest" as const,
      url: "https://a.example/1",
      urlKey: "key-1",
      simhash: "0123456789abcdef",
      title: "Concorso Nutella",
      summary: "Partecipa e vinci",
      publishedAt: NOW.toISOString(),
      firstSeenAt: NOW.toISOString(),
      lastSeenAt: NOW.toISOString(),
      deadline: "2026-11-30",
      prize: "1000 euro",
      participation: "iscrizione online",
      rulesUrl: null,
      prizeValue: 0.8,
      effort: 0.9,
      requiresPurchase: false,
      tags: ["giftcard"],
      score: 10,
      clusterId: null,
      status: "new" as const,
      aiUsed: false,
    };
    const atteso = scoreItem(
      insight({ deadline: "2026-11-30", prize: "1000 euro", prizeValue: 0.8, effort: 0.9, tags: ["giftcard"] }),
      riga,
      { giftcard: 1 },
      NOW,
      ["ferrero"],
    );
    expect(rescoreRow(riga, { giftcard: 1 }, ["ferrero"], NOW)).toBe(atteso);
    expect(rescoreRow(riga, { giftcard: 1 }, [], NOW)).toBe(atteso - SCORE_WEIGHTS.favoriteBrand);
    expect(rescoreRow(riga, { giftcard: 1 }, ["ferrero"], NOW)).not.toBe(riga.score);
  });

  it("la spiegazione somma esattamente al punteggio, anche con pesi e marca", () => {
    // Il patto della scheda: i numeri che leggi sommano al voto. Non "circa":
    // il voto è ciò che decide se un concorso passa il filtro delle stelle, e una
    // spiegazione che non torna è peggio di nessuna spiegazione.
    const casi: Array<{
      nome: string;
      insight: ReturnType<typeof insight>;
      item: { title: string; summary: string; publishedAt?: string | null; brand?: string | null };
      weights: Record<string, number>;
      favorites: string[];
    }> = [
      {
        nome: "concorso tipico con gift card",
        insight: insight({ prizeValue: 0.8, effort: 0.9, deadline: "2026-11-30", tags: ["giftcard"] }),
        item: { title: "Concorso Nutella", summary: "Partecipa e vinci", publishedAt: NOW.toISOString(), brand: "ferrero" },
        weights: { giftcard: 1 },
        favorites: ["ferrero"],
      },
      {
        nome: "titolo debole e scadenza passata",
        insight: insight({ prizeValue: 0.2, effort: 0.1, deadline: "2026-10-01", requiresPurchase: true }),
        item: { title: "Gadget", summary: "" },
        weights: {},
        favorites: [],
      },
      {
        nome: "premio massimo: la base sfonda il tetto 100",
        insight: insight({ prizeValue: 1, effort: 1, deadline: "2026-10-18", tags: ["giftcard"] }),
        item: { title: "In palio una Fiat Panda", summary: "Concorso gratuito", publishedAt: NOW.toISOString() },
        weights: { giftcard: 5 },
        favorites: [],
      },
      {
        nome: "pesi negativi: il punteggio tocca il pavimento",
        insight: insight({ prizeValue: 0.05, effort: 0.05, deadline: "2027-12-31", requiresPurchase: true }),
        item: { title: "Concorso piccolo", summary: "x" },
        weights: { giftcard: -10 },
        favorites: [],
      },
    ];

    for (const caso of casi) {
      const spiegazione = explainScore(caso.insight, caso.item, caso.weights, NOW, caso.favorites);
      const somma = spiegazione.parts.reduce((totale, voce) => totale + voce.points, 0);
      expect(spiegazione.total, caso.nome).toBe(scoreItem(caso.insight, caso.item, caso.weights, NOW, caso.favorites));
      // La somma delle voci fa il totale: nessun resto nascosto.
      expect(somma, caso.nome).toBe(spiegazione.total);
      // Le voci del corpo ci sono sempre, anche a zero: è il "premio 0/30" che
      // spiega un voto basso.
      for (const chiave of ["premio", "sforzo", "scadenza", "freschezza", "senzaAcquisto"]) {
        expect(spiegazione.parts.some((voce) => voce.key === chiave), `${caso.nome}: manca ${chiave}`).toBe(true);
      }
    }
  });

  it("la spiegazione dice il tetto, e nomina gusti e marca solo quando contano", () => {
    const somma = (spiegazione: ReturnType<typeof explainScore>): number =>
      spiegazione.parts.reduce((totale, voce) => totale + voce.points, 0);

    // Base sotto zero (scaduta, con acquisto, titolo debole): il taglio a 0 è una
    // voce, non un mistero — e le voci sommano comunque al totale.
    const pavimento = explainScore(
      insight({ prizeValue: 0, effort: 0, deadline: "2026-10-01", requiresPurchase: true }),
      { title: "Gadget", summary: "" },
      {},
      NOW,
      [],
    );
    const limite = pavimento.parts.find((voce) => voce.key === "limite");
    expect(limite?.points).toBeGreaterThan(0);
    expect(limite?.label).toContain("Minimo");
    expect(pavimento.total).toBe(0);
    expect(somma(pavimento)).toBe(0);

    // Il tetto 100 arriva dai pesi (la base da sola non ci arriva: il massimo
    // teorico è 95): quello che conta è che le voci non raccontino più di 100.
    const conPesi = explainScore(
      insight({ prizeValue: 1, effort: 1, deadline: "2026-10-18", tags: ["giftcard"] }),
      { title: "In palio una Fiat Panda", summary: "Concorso gratuito", publishedAt: NOW.toISOString(), brand: "ferrero" },
      { giftcard: 20 },
      NOW,
      ["ferrero"],
    );
    expect(conPesi.total).toBe(100);
    expect(somma(conPesi)).toBe(100);

    const senzaGusti = explainScore(
      insight({ prizeValue: 0.5, effort: 0.5, deadline: "2027-05-01" }),
      { title: "Concorso Esselunga", summary: "x" },
      {},
      NOW,
      [],
    );
    expect(senzaGusti.parts.some((voce) => voce.key === "gusti")).toBe(false);
    expect(senzaGusti.parts.some((voce) => voce.key === "marca")).toBe(false);

    const conTutto = explainScore(
      insight({ prizeValue: 0.5, effort: 0.5, deadline: "2027-05-01", tags: ["giftcard"] }),
      { title: "Concorso Esselunga", summary: "x", brand: "esselunga" },
      { giftcard: -2 },
      NOW,
      ["esselunga"],
    );
    expect(conTutto.parts.find((voce) => voce.key === "gusti")?.points).toBe(-6);
    expect(conTutto.parts.find((voce) => voce.key === "marca")?.points).toBe(SCORE_WEIGHTS.favoriteBrand);
  });
});

describe("arricchimento AI (con tetto e senza eccezioni)", () => {
  const testo = "Concorso promosso da un'azienda alimentare con premi interessanti per i clienti finali.";

  it("decide quando serve l'AI", () => {
    expect(needsAi(insight({ deadline: null }), { title: "x", summary: testo })).toBe(true);
    expect(needsAi(insight({ deadline: "2026-11-30", prize: "un buono spesa" }), { title: "x", summary: testo })).toBe(false);
    expect(needsAi(insight({ deadline: null }), { title: "x", summary: "Troppo breve" })).toBe(false);
  });

  it("usa la risposta del modello quando è JSON valido", async () => {
    const store = createMemoryStore();
    const ai: AiBinding = {
      async run() {
        return {
          response:
            '{"deadline":"2026-11-30","prize":"gift card da 500 euro","participation":"iscrizione online",' +
            '"requires_purchase":false,"prize_value":0.9,"effort":1,"tags":["giftcard"]}',
        };
      },
    };
    const patch = await enrichWithAi({ title: "Concorso", summary: testo }, { ai, store, now: NOW });
    expect(patch?.deadline).toBe("2026-11-30");
    expect(patch?.prizeValue).toBe(0.9);
    expect(patch?.tags).toEqual(["giftcard"]);
    expect(await store.aiUsage("2026-10-16")).toBeGreaterThan(0);
  });

  it("scarta una scadenza non valida senza applicare nulla", async () => {
    const store = createMemoryStore();
    const ai: AiBinding = { async run() { return { response: '{"deadline":"2020-01-01"}' }; } };
    expect(await enrichWithAi({ title: "Concorso", summary: testo }, { ai, store, now: NOW })).toBeNull();
  });

  it("non fa nulla se il modello risponde senza JSON", async () => {
    const store = createMemoryStore();
    const ai: AiBinding = { async run() { return { response: "Non posso aiutarti con questa richiesta." }; } };
    expect(await enrichWithAi({ title: "Concorso", summary: testo }, { ai, store, now: NOW })).toBeNull();
  });

  it("non lancia eccezioni quando il modello fallisce", async () => {
    const store = createMemoryStore();
    const ai: AiBinding = { async run() { throw new Error("4970 rate limited"); } };
    expect(await enrichWithAi({ title: "Concorso", summary: testo }, { ai, store, now: NOW })).toBeNull();
  });

  it("rispetta il tetto giornaliero di Neurons", async () => {
    const store = createMemoryStore();
    await store.addAiUsage("2026-10-16", 99, MAX_NEURONS_PER_DAY);
    const ai: AiBinding = { async run() { return { response: '{"prize":"x"}' }; } };
    expect(await enrichWithAi({ title: "Concorso", summary: testo }, { ai, store, now: NOW })).toBeNull();
  });

  it("non chiama nulla senza binding AI", async () => {
    const store = createMemoryStore();
    expect(await enrichWithAi({ title: "Concorso", summary: testo }, { ai: null, store, now: NOW })).toBeNull();
  });

  it("mergeInsight riempie solo i buchi delle regole", () => {
    const base = insight({ deadline: "2026-11-30", prize: null, tags: ["gratis"] });
    const merged = mergeInsight(base, { deadline: "2027-01-01", prize: "buono spesa", tags: ["giftcard"], aiUsed: true });
    expect(merged.deadline).toBe("2026-11-30");
    expect(merged.prize).toBe("buono spesa");
    expect(merged.tags).toEqual(["gratis", "giftcard"]);
    expect(merged.aiUsed).toBe(true);
  });
});
