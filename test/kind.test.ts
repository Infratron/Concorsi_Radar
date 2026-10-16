import { describe, expect, it } from "vitest";
import { classifyKind } from "../src/enrich/kind.ts";
import type { SourceKind } from "../src/types.ts";

/**
 * Concorso o articolo.
 * I casi "concorso" sono i venti item veri dell'archivio del 16/10/2026: la
 * classificazione non deve spostarne nessuno. I casi "articolo" sono i
 * contenitori che l'utente ha segnalato (la tassonomia di PremieConcorsi, la
 * notizia di Google News) e le forme tipiche di una pagina-elenco.
 */

function kind(url: string, title: string, sourceKind: SourceKind = "rss") {
  return classifyKind({ url, title, sourceKind });
}

describe("concorso o articolo", () => {
  it("lascia concorso tutte le pagine di concorso in archivio", () => {
    const concorsi: [string, string][] = [
      ["https://premieconcorsi.com/contest.php?CID=24515", "LA CACCIA AL TESORO DEL CAPITANO"],
      ["https://premieconcorsi.com/contest.php?CID=24513", "Vinci X Factor 2026 con Crema Novi"],
      ["https://vincimi.it/operazione-a-premio/upsa-glow-win-vinci-premi-beauty", "UPSA Glow & Win"],
      ["https://soldissimi.it/vinci-con-cupper", "Vinci con Cupper"],
      ["https://dimmicosacerchi.it/concorso-mms.html", "Concorso Mars: vinci Disneyland Paris"],
      ["https://scontrinofelice.it/concorsi-con-acquisto/concorso-lievital", "Concorso Lievital"],
      ["https://scontrinofelice.it/concorsi-gratuiti/concorso-gratuito-kanzi", "Concorso gratuito Kanzi"],
      ["https://coca-cola.com/it/it/offerings/bevi-coca-cola-zero-e-vinci-con-gusto", "Bevi Coca-Cola Zero"],
      ["https://ferrero.com/it/it/promozioni/vinciwonka2026", "Vinciwonka 2026"],
      ["https://sammontana.it/novita-e-progetti/gusta-e-vinci.html", "Gusta E Vinci"],
      [
        "https://sammontana.it/novita-e-progetti/news-ed-eventi/gusta-gioca-vinci-gardaland.html",
        "Gusta Gioca Vinci Gardaland",
      ],
      [
        "https://sammontana.it/novita-e-progetti/gusta-e-vinci/sammontana-e-gardaland-sorrisi-per-tutta-la-famiglia.html",
        "Sammontana E Gardaland",
      ],
      ["https://www.eni.com/piu-insieme/concorsi-premi/vinci-un-auto", "Concorso Eni"],
    ];
    for (const [url, title] of concorsi) expect(kind(url, title), url).toBe("contest");
  });

  it("sposta in news la pagina di categoria trovata dentro una cartella di concorsi", () => {
    // Il caso reale: la sitemap di PremieConcorsi pubblica le tassonomie, e in
    // chat comparivano come concorsi dal titolo "A Partecipazione Gratuita".
    expect(
      kind("https://premieconcorsi.com/concorsi-a-premi/a-partecipazione-gratuita", "A Partecipazione Gratuita", "sitemap"),
    ).toBe("news");
    expect(
      kind("https://premieconcorsi.com/concorsi-a-premi/concorsi-fotografici", "Concorsi Fotografici", "sitemap"),
    ).toBe("news");
    // Una pagina-elenco scritta in chiaro: titolo e link lo dicono.
    expect(kind("https://premieconcorsi.com/concorsi", "Tutti i concorsi a premi", "sitemap")).toBe("news");
  });

  it("sposta in news le notizie: la fonte news è un articolo per costruzione", () => {
    expect(
      kind(
        "https://news.google.com/rss/articles/CBMif0FVX3lxTE1hYmI?oc=5",
        "Saka Mikami a Lucca Comics 2026: come partecipare ai firmacopie",
        "news",
      ),
    ).toBe("news");
  });

  it("sposta in news le pagine-elenco", () => {
    expect(kind("https://www.dimmicosacerchi.it/concorsi-a-premi/", "Concorsi a premi")).toBe("news");
    expect(kind("https://www.scontomaggio.com/promozioni/", "Promozioni")).toBe("news");
    expect(kind("https://www.example.it/news/", "Ultime notizie")).toBe("news");
  });

  it("sposta in news i titoli che promettono un elenco", () => {
    expect(kind("https://blog.example.it/post-123", "Tutti i concorsi a premi di ottobre")).toBe("news");
    expect(kind("https://blog.example.it/come-vincere", "I migliori concorsi del mese")).toBe("news");
    expect(kind("https://blog.example.it/20-concorsi", "20 concorsi a premi da provare")).toBe("news");
    expect(kind("https://blog.example.it/rassegna", "Rassegna dei concorsi in scadenza")).toBe("news");
  });

  it("riconosce i permalink con la data", () => {
    expect(kind("https://www.ilgiornale.it/2026/05/19/concorso-nutella-vinci", "Concorso Nutella: vinci")).toBe("news");
  });

  it("nel dubbio preferisce concorso", () => {
    expect(kind("https://www.brand.it/concorso-barilla", "Concorso Barilla: vinci una cucina")).toBe("contest");
    expect(kind("https://www.brand.it/vinci-un-viaggio", "Vinci un viaggio a Parigi")).toBe("contest");
    // Un URL illeggibile non è una prova: non si sposta niente.
    expect(kind("non-un-url", "Concorso Lievital")).toBe("contest");
  });
});
