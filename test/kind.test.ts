import { describe, expect, it } from "vitest";
import { classifyKind } from "../src/enrich/kind.ts";
import type { Category, SourceKind } from "../src/types.ts";

/**
 * Concorso, coupon o articolo.
 * I casi "concorso" sono i venti item veri dell'archivio del 16/10/2026: la
 * classificazione non deve spostarne nessuno. I casi "articolo" sono i
 * contenitori che l'utente ha segnalato (la tassonomia di PremieConcorsi, la
 * notizia di Google News) e le forme tipiche di una pagina-elenco. I casi
 * "coupon" sono i titoli veri letti il 16/10/2026 dai tre feed di buoni sconto.
 */

function kind(
  url: string,
  title: string,
  sourceKind: SourceKind = "rss",
  sourceCategory: Category = "altro",
) {
  return classifyKind({ url, title, sourceKind, sourceCategory });
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

  it("non scambia per categoria una promozione con le date nel nome", () => {
    // Caso reale (17/10/2026): il nome comincia con "dal-", quindi la regola
    // della tassonomia le spostava in 📰 News, dove non c'entravano niente. Sono
    // pagine di concorso, con marca e premio dentro lo slug.
    const aia = (slug: string) => kind(`https://aiafood.com/it/concorsi/${slug}`, slug, "sitemap");
    expect(aia("dal-15-ottobre-al-1-novembre-2026-vinci-un-barbecue-portatile-lotus-grill")).toBe("contest");
    expect(aia("dal-25-novembre-al-10-dicembre-2024-vinci-con-aia")).toBe("contest");
    // La tassonomia vera resta un contenitore.
    expect(aia("a-partecipazione-gratuita")).toBe("news");
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
    // Caso reale di Scontrino Felice: la pagina che raccoglie le iniziative con
    // rimborso non è un concorso, è l'indice di quelli.
    expect(
      kind(
        "https://www.scontrinofelice.it/spendi-e-riprendi/provami-gratis-spendi-e-riprendi-cashback/",
        "Provami Gratis e Cashback 2026: elenco completo delle iniziative con rimborso attive",
      ),
    ).toBe("news");
  });

  it("NON sposta in news la pagina che ripete la cartella", () => {
    // Misurato il 16/10/2026 sulla prova dal vivo di Scontrino Felice: la sezione
    // "premio certo" pubblica /premio-certo/premio-certo-<marca>, e la regola
    // sulle tassonomie mandava in news tutte e 21 le promo della sezione — che
    // sono premi da richiedere, non rassegne.
    expect(kind("https://scontrinofelice.it/premio-certo/premio-certo-apropos", "Apropos: ricevi un buono Amazon da 10 euro")).toBe(
      "contest",
    );
    expect(
      kind("https://scontrinofelice.it/premio-certo/premio-certo-bioritmon", "Bioritmon: richiedi voucher benessere e gift card"),
    ).toBe("contest");
  });

  it("NON legge una frase da elenco dentro un titolo di promo", () => {
    // "tutti i premi" è una formula da rassegna solo se apre il titolo: dopo
    // "scopri" è il premio di una raccolta punti, che è un concorso a tutti gli
    // effetti.
    expect(
      kind("https://scontrinofelice.it/raccolte-punti/raccolta-bollini-bennet", "Raccolta bollini Bennet Guzzini: scopri tutti i premi"),
    ).toBe("contest");
    expect(
      kind(
        "https://scontrinofelice.it/raccolte-punti/raccolta-punti-italmark",
        "Raccolta punti Italmark Friends: scopri tutti i premi da collezionare",
      ),
    ).toBe("contest");
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

describe("coupon e rimborsi", () => {
  it("una fonte di coupon porta coupon, anche quando le parole non lo dicono", () => {
    // Il caso reale: le sezioni "spendi e riprendi" dei tre siti. Qui è la FONTE
    // a dire che cosa pubblica, categoria `coupon` in src/config/sources.ts.
    expect(
      kind(
        "https://www.scontrinofelice.it/spendi-e-riprendi/cashback-ymea/",
        "Cashback Ymea “Mese della menopausa”: richiedi 25 euro di rimborso",
        "rss",
        "coupon",
      ),
    ).toBe("coupon");
    expect(
      kind(
        "https://www.scontrinofelice.it/buoni-sconto/buono-sconto-crema-novi/",
        "Buono sconto Crema Novi Fondente da scaricare subito",
        "rss",
        "coupon",
      ),
    ).toBe("coupon");
  });

  it("un premio annunciato vince sullo sconto: quella metà resta un concorso", () => {
    // Caso reale del 16/10/2026: un rimborso E un'estrazione nella stessa riga.
    // Nascondere il concorso costerebbe più di un coupon di troppo.
    expect(
      kind(
        "https://www.scontrinofelice.it/spendi-e-riprendi/cashback-fabuloso/",
        "Cashback Fabuloso, Ajax, Soflan: ricevi un rimborso di 5 euro e vinci lavatrice Samsung",
        "rss",
        "coupon",
      ),
    ).toBe("contest");
    expect(kind("https://www.brand.it/prova-e-vinci", "Provami gratis e vinci una bici", "rss", "coupon")).toBe(
      "contest",
    );
  });

  it("un buono sconto resta un buono sconto anche da un aggregatore di concorsi", () => {
    // Le parole bastano, e non serve la categoria della fonte: è il caso dei
    // buoni sconto che arrivano dal feed generale di un aggregatore.
    expect(kind("https://www.scontrinofelice.it/buoni-sconto/riscatta-codice-lidl/", "Riscatta Codice Lidl")).toBe(
      "coupon",
    );
    expect(kind("https://www.dimmicosacerchi.it/buoni-sconto-regina-carta.html", "Buoni sconto Regina da stampare")).toBe(
      "coupon",
    );
    expect(kind("https://www.x.it/promo/sconto-da-stampare-lavazza", "Sconto da stampare Lavazza")).toBe("coupon");
  });

  it("la cartella dei buoni sconto è un contenitore, non un'offerta", () => {
    expect(kind("https://www.scontrinofelice.it/buoni-sconto/", "Buoni Sconto")).toBe("news");
    expect(kind("https://www.scontomaggio.com/coupon/", "Coupon da stampare")).toBe("news");
  });

  it("NON legge uno sconto dove c'è un premio", () => {
    // "buono spesa da 500 euro" è il premio di un concorso (vedi BONUS_PATTERN in
    // src/enrich/score.ts): il segnale deve dire lo SCONTO, non il buono.
    expect(kind("https://www.brand.it/concorso-spesa", "Concorso: vinci un buono spesa da 500 euro")).toBe("contest");
    expect(kind("https://www.brand.it/vinci-voucher", "Vinci un voucher da 100 euro")).toBe("contest");
  });
});
