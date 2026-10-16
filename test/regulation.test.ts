import { describe, expect, it } from "vitest";
import { bestRegulationLink, isSamePage, regulationUrlFromPage, regulationUrlFromText } from "../src/enrich/regulation.ts";
import type { FetchLike } from "../src/types.ts";

/**
 * La ricerca del regolamento (il bando) di un concorso.
 *
 * I casi sono quelli veri, misurati il 16/10/2026 sulle pagine delle fonti in
 * archivio: il bando è un link in fondo alla pagina del concorso ("Regolamento
 * completo", "Scarica il bando in PDF"), il riassunto del feed non lo nomina, e
 * intorno ci sono privacy, cookie, social e menù — cioè tutto quello che NON è il
 * regolamento.
 */

const NOW = new Date("2026-10-16T12:00:00.000Z");
/** La pagina di un rimborso con premio, presa da Scontrino Felice. */
const PAGINA = "https://www.scontrinofelice.it/spendi-e-riprendi/cashback-ymea/";

describe("regolamento · nel testo dell'item", () => {
  it("trova il bando citato nel riassunto", () => {
    expect(
      regulationUrlFromText("Vedi https://esempio.it/regolamento.pdf per i dettagli", "https://esempio.it/concorso"),
    ).toBe("https://esempio.it/regolamento.pdf");
  });

  it("accetta le altre parole con cui si chiama il bando", () => {
    expect(regulationUrlFromText("Bando su https://esempio.it/bando-2026", null)).toBe(
      "https://esempio.it/bando-2026",
    );
    expect(
      regulationUrlFromText("Tutto in https://esempio.it/modalita-di-partecipazione al concorso", null),
    ).toBe("https://esempio.it/modalita-di-partecipazione");
  });

  it("non prende per bando un link che non lo nomina", () => {
    expect(regulationUrlFromText("Iscriviti su https://esempio.it/iscrizione", null)).toBeNull();
  });

  it("non ripete la pagina del concorso, nemmeno con la barra finale o senza www", () => {
    expect(regulationUrlFromText("Qui: https://www.esempio.it/concorso/", "https://esempio.it/concorso")).toBeNull();
  });

  it("a parità di candidati vince il PDF", () => {
    expect(
      regulationUrlFromText(
        "Regolamento: https://esempio.it/concorso/regolamento oppure https://esempio.it/files/bando.pdf",
        null,
      ),
    ).toBe("https://esempio.it/files/bando.pdf");
  });

  it("perde la punteggiatura finale, che non fa parte dell'URL", () => {
    expect(regulationUrlFromText("Leggi il regolamento: https://esempio.it/bando.pdf.", null)).toBe(
      "https://esempio.it/bando.pdf",
    );
  });
});

describe("regolamento · fra i link della pagina", () => {
  it("trova il bando quando l'URL non lo nomina ma l'ancora sì", () => {
    const html = `
      <footer>
        <a href="/files/2026/ymea.pdf"><strong>Regolamento</strong> completo della promozione</a>
      </footer>`;
    expect(bestRegulationLink(html, PAGINA)).toBe("https://www.scontrinofelice.it/files/2026/ymea.pdf");
  });

  it("risolve i link relativi e ignora un link alla pagina stessa", () => {
    const html = `
      <a href="/spendi-e-riprendi/cashback-ymea/">Torna alla promozione</a>
      <a href="regolamento-ymea.html">Regolamento e modalità di partecipazione</a>`;
    // Il link relativo si risolve sulla cartella della pagina (l'URL finisce con
    // la barra), come farebbe un browser.
    expect(bestRegulationLink(html, PAGINA)).toBe(
      "https://www.scontrinofelice.it/spendi-e-riprendi/cashback-ymea/regolamento-ymea.html",
    );
  });

  it("non scambia privacy, cookie o social per il bando", () => {
    const html = `
      <a href="/privacy-policy">Privacy</a>
      <a href="/cookie">Cookie</a>
      <a href="https://www.facebook.com/sharer.php?u=x">Condividi su Facebook</a>
      <a href="https://t.me/share/url?url=x">Telegram</a>`;
    expect(bestRegulationLink(html, PAGINA)).toBeNull();
  });

  it("non inventa niente quando il bando non c'è", () => {
    const html = `<a href="/chi-siamo">Chi siamo</a><a href="/contatti">Contatti</a><a href="/">Home</a>`;
    expect(bestRegulationLink(html, PAGINA)).toBeNull();
  });

  it("preferisce il bando vero al link che lo nomina di sfuggita", () => {
    // Due candidati: uno è la pagina del bando in PDF (ancora che invita a
    // scaricare), l'altro è un articolo che parla di regolamenti in generale.
    const html = `
      <a href="/blog/2026/regolamenti-dei-concorsi">Come funzionano i regolamenti dei concorsi</a>
      <a href="/files/bando-ymea.pdf">Scarica il bando completo (PDF)</a>`;
    expect(bestRegulationLink(html, PAGINA)).toBe("https://www.scontrinofelice.it/files/bando-ymea.pdf");
  });

  it("riconosce la stessa pagina anche quando cambia solo il prefisso o la barra", () => {
    expect(isSamePage("https://esempio.it/concorso/", "https://www.esempio.it/concorso")).toBe(true);
    expect(isSamePage("https://esempio.it/concorso-barilla", "https://esempio.it/concorso")).toBe(false);
  });
});

describe("regolamento · dalla pagina, con le regole di lettura", () => {
  const HTML = `<html><body><a href="/files/bando.pdf">Regolamento completo</a></body></html>`;

  function deps(fetcher: FetchLike, allows: (url: string) => Promise<boolean>) {
    return { fetcher, userAgent: "test", allows, now: NOW };
  }

  it("legge la pagina e restituisce il link trovato", async () => {
    const fetcher: FetchLike = async (input) =>
      String(input) === PAGINA ? new Response(HTML, { status: 200 }) : new Response("no", { status: 404 });

    expect(await regulationUrlFromPage(PAGINA, deps(fetcher, async () => true))).toBe(
      "https://www.scontrinofelice.it/files/bando.pdf",
    );
  });

  it("non legge niente dove robots.txt lo vieta", async () => {
    let letture = 0;
    const fetcher: FetchLike = async () => {
      letture++;
      return new Response(HTML, { status: 200 });
    };

    expect(await regulationUrlFromPage(PAGINA, deps(fetcher, async () => false))).toBeNull();
    expect(letture).toBe(0);
  });

  it("una pagina che non risponde non fa fallire l'ingestione", async () => {
    const fetcher: FetchLike = async () => new Response("vietato", { status: 403 });
    expect(await regulationUrlFromPage(PAGINA, deps(fetcher, async () => true))).toBeNull();

    const rotta: FetchLike = async () => {
      throw new Error("rete giù");
    };
    expect(await regulationUrlFromPage(PAGINA, deps(rotta, async () => true))).toBeNull();
  });
});
