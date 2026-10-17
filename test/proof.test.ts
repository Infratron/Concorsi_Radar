import { describe, expect, it } from "vitest";
import { claimFrom, dutiesFor, keepFrom } from "../src/enrich/proof.ts";

/**
 * Cosa conservare e quando chiedere il premio.
 *
 * Perché meritano test: sono due righe che restano sulla scheda, quindi
 * un'estrazione sbagliata non passa inosservata — e le due trappole vere sono
 * "senza scontrino" (che non deve diventare "conserva lo scontrino") e la
 * scadenza della partecipazione scambiata per quella della richiesta.
 */

const NOW = new Date("2026-10-17T09:00:00.000Z");

describe("cosa conservare", () => {
  it("prende scontrino e codice, senza ripeterli", () => {
    expect(keepFrom("Conserva lo scontrino originale e il codice sulla confezione.")).toBe(
      "lo scontrino originale e il codice sulla confezione",
    );
    // Un bando che scrive due volte lo scontrino non deve produrre due voci.
    expect(keepFrom("Serve lo scontrino. Lo scontrino va conservato.")).toBe("lo scontrino");
  });

  it("riconosce bollini, francobolli, tappi e confezioni", () => {
    expect(keepFrom("Raccolta bollini: incolla i bollini sulla cartolina")).toBe("i bollini");
    // Bollini e punti sono la stessa cosa: una voce sola, non due.
    expect(keepFrom("Raccogli i bollini e i punti della raccolta")).toBe("i bollini");
    // Dove i bollini non ci sono, i punti si dicono lo stesso.
    expect(keepFrom("Con i punti fedeltà del supermercato")).toBe("i punti della raccolta");
    expect(keepFrom("Conserva i francobolli della raccolta")).toBe("i francobolli");
    expect(keepFrom("Partecipa con il codice sotto il tappo e conserva la confezione")).toBe(
      "il codice sotto il tappo e la confezione",
    );
  });

  it("non dice di conservare niente quando l'acquisto non serve", () => {
    // La trappola vera: "senza scontrino" non è "conserva lo scontrino".
    expect(keepFrom("Concorso senza obbligo di acquisto: nessuno scontrino da conservare")).toBeNull();
    expect(keepFrom("Partecipazione gratuita, non serve scontrino")).toBeNull();
    expect(keepFrom("Vinci un viaggio senza spendere niente")).toBeNull();
  });

  it("non scambia un requisito d'acquisto per una prova da conservare", () => {
    // Caso vero (Haribo Halloween): "acquista 3 confezioni" è quanto serve
    // comprare, non la confezione da tenere.
    expect(keepFrom("Acquista almeno 3 confezioni di caramelle e partecipa")).toBeNull();
    expect(keepFrom("Acquista 3 confezioni e conserva la confezione")).toBe("la confezione");
  });

  it("in un concorso gratuito non c'è niente da conservare", () => {
    // Caso vero (Trü Frü): le confezioni nominate sono il premio, non la prova.
    expect(keepFrom("Concorso gratuito: in palio kit da 3 confezioni e una maglietta")).toBeNull();
  });

  it("resta zitto quando il testo non nomina nessuna prova", () => {
    expect(keepFrom("Registrati sul sito e compila il form")).toBeNull();
    expect(keepFrom("")).toBeNull();
  });
});

describe("quando il premio va richiesto", () => {
  it("legge la data della richiesta", () => {
    expect(claimFrom("Il premio deve essere richiesto entro il 31/12/2026.", NOW)).toEqual({
      kind: "date",
      date: "2026-12-31",
    });
    expect(claimFrom("Richiedi il tuo premio entro il 15 dicembre 2026", NOW)).toEqual({
      kind: "date",
      date: "2026-12-15",
    });
  });

  it("legge il conto in giorni e da quando decorrono", () => {
    expect(claimFrom("Il vincitore dovrà ritirare il premio entro 10 giorni dalla comunicazione della vincita.", NOW)).toEqual({
      kind: "days",
      days: 10,
      from: "dalla comunicazione della vincita",
    });
    // L'apostrofo resta attaccato: "dall'estrazione", non "dall' estrazione".
    expect(claimFrom("Riscatta il premio entro 90 giorni dall'estrazione", NOW)).toEqual({
      kind: "days",
      days: 90,
      from: "dall'estrazione",
    });
    expect(claimFrom("Il premio va richiesto entro 30 giorni", NOW)).toEqual({
      kind: "days",
      days: 30,
      from: null,
    });
  });

  it("non scambia la scadenza della partecipazione per quella della richiesta", () => {
    expect(claimFrom("Partecipa entro il 30/11/2026 e vinci buoni spesa", NOW)).toBeNull();
    // "Richiedi il codice sconto" non è un premio: è un coupon.
    expect(claimFrom("Richiedi il codice sconto entro il 30/11/2026", NOW)).toBeNull();
    // Una data già passata non è una finestra ancora aperta.
    expect(claimFrom("Il premio va richiesto entro il 01/01/2026", NOW)).toBeNull();
  });

  it("non inventa una data quando il testo non la dice", () => {
    expect(claimFrom("Il premio non arriva da solo: richiedilo", NOW)).toBeNull();
  });
});

describe("quando il testo non nomina la prova", () => {
  it("una raccolta punti conserva scontrini e bollini", () => {
    const doveri = dutiesFor(
      // Il testo non nomina né bollini né scontrini: la riga arriva dal tag.
      { title: "Raccolta PiùMe", summary: "Con i punti accumulati ritiri i premi", tags: ["raccolta_punti"] },
      NOW,
    );
    expect(doveri.keep).toBe("gli scontrini e i bollini");
  });

  it("un concorso con acquisto conserva la prova d'acquisto", () => {
    const doveri = dutiesFor(
      { title: "Concorso Cupper", summary: "Acquista i prodotti Cupper e partecipa", requiresPurchase: true },
      NOW,
    );
    expect(doveri.keep).toBe("lo scontrino o la prova d'acquisto");
  });

  it("ma non quando il testo dice che non si compra niente", () => {
    const doveri = dutiesFor(
      { title: "Concorso gratuito Syoss", summary: "Meccanismo instant win, facile e gratuito", requiresPurchase: true },
      NOW,
    );
    expect(doveri.keep).toBeNull();
  });

  it("la prova nominata vince sulla riga generica", () => {
    const doveri = dutiesFor(
      { title: "Raccolta bollini", summary: "Attacca i bollini sulla cartolina", tags: ["raccolta_punti"] },
      NOW,
    );
    expect(doveri.keep).toBe("i bollini");
  });
});

describe("le due righe insieme", () => {
  it("legge titolo e riassunto come un testo solo", () => {
    const doveri = dutiesFor(
      {
        title: "Concorso Findus: 1000 euro di buoni spesa",
        summary: "Serve lo scontrino. Il premio va richiesto entro 30 giorni dalla comunicazione.",
      },
      NOW,
    );
    expect(doveri.keep).toBe("lo scontrino");
    expect(doveri.claim).toEqual({ kind: "days", days: 30, from: "dalla comunicazione" });
  });
});
