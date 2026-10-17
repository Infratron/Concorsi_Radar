import { describe, expect, it } from "vitest";
import {
  COUPON_TTL_DAYS,
  STALE_PAGE_DAYS,
  indexPageUrls,
  staleItemReason,
  staleReason,
  type FreshnessInput,
} from "../src/enrich/freshness.ts";

/**
 * Il cancello di "concorso ancora attivo".
 * I casi sono presi dalle fonti vere misurate il 16/10/2026: la sitemap Conad
 * (catalogo di tazze e borse sotto /collezioni-e-concorsi/, promo del 2025), il
 * catalogo Lavazza di kit e capsule, le pagine indice di premi e concorsi, e i
 * concorsi veri di Eni che invece devono passare.
 */

const NOW = new Date("2026-10-16T10:00:00.000Z");

function item(partial: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    title: "Concorso esempio",
    url: "https://www.esempio.it/concorsi/esempio",
    summary: "",
    publishedAt: null,
    deadline: null,
    fromListing: false,
    // Di default è un concorso: le prove sui coupon lo dicono esplicitamente.
    kind: "contest",
    ...partial,
  };
}

describe("cancello · concorso ancora attivo", () => {
  it("una scadenza futura salva anche una pagina di catalogo", () => {
    expect(
      staleReason(
        item({
          title: "Minecraft",
          url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/minecraft",
          publishedAt: "2025-05-06T00:00:00.000Z",
          deadline: "2026-11-30",
          fromListing: true,
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("scarta una promozione il cui intervallo di date è già finito", () => {
    // Caso reale (pagine AIA, 17/10/2026): nessuna parola di chiusura, nessuna
    // scadenza estraibile (la data è passata), ma il titolo dice "Dal 26 Agosto
    // Al 16 Settembre 2026": una promo stagionale conclusa da un mese.
    expect(
      staleReason(
        item({
          title: "Dal 26 Agosto Al 16 Settembre 2026 Vinci Con Negroni And Aia",
          url: "https://aiafood.com/it/concorsi/dal-26-agosto-al-16-settembre-2026-vinci-con-negroni-and-aia",
          publishedAt: "2026-08-26T10:25:09.606Z",
          fromListing: true,
        }),
        NOW,
      ),
    ).toBe("edizione chiusa (2026)");
    // Un intervallo ancora aperto invece passa.
    expect(
      staleReason(
        item({
          title: "Dal 15 Ottobre Al 1 Novembre 2026 Vinci Un Barbecue",
          url: "https://aiafood.com/it/concorsi/dal-15-ottobre-al-1-novembre-2026-vinci-un-barbecue",
          publishedAt: "2026-10-15T08:54:51.445Z",
          deadline: "2026-11-01",
          fromListing: true,
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("scarta l'edizione di un anno passato", () => {
    expect(
      staleReason(item({ title: "Premia te e l'ambiente 2024", publishedAt: "2024-07-02T00:00:00.000Z" }), NOW),
    ).toBe("edizione chiusa (2024)");
    // L'anno nell'URL vale quanto quello nel titolo: è così che si presenta la
    // pagina di una promo vecchia quando il titolo è lo slug.
    expect(
      staleReason(
        item({ title: "Concorso di Natale", url: "https://www.esempio.it/concorso-natale-2025/", fromListing: true }),
        NOW,
      ),
    ).toBe("edizione chiusa (2025)");
    // L'anno corrente non è un'edizione chiusa.
    expect(staleReason(item({ title: "Calendario Nutella 2026", fromListing: true }), NOW)).toBeNull();
  });

  it("riconosce le parole di un concorso già finito", () => {
    expect(staleReason(item({ summary: "Ecco i vincitori del concorso." }), NOW)).toBe("concorso già chiuso");
    expect(staleReason(item({ title: "Concorso concluso, grazie a tutti" }), NOW)).toBe("concorso già chiuso");
    // Le sitemap dei brand sono piene di pagine che annunciano i vincitori: il
    // titolo è lo slug e comincia proprio con quella parola (misurato il
    // 16/10/2026 su Pampers: "I Vincitori 2013" entrava in archivio).
    expect(staleReason(item({ title: "I Vincitori 2013", fromListing: true }), NOW)).toBe("concorso già chiuso");
    expect(staleReason(item({ title: "Vincitori", fromListing: true }), NOW)).toBe("concorso già chiuso");
    // Al futuro invece il concorso è vivo: "si concluderà" non è "concluso".
    expect(staleReason(item({ summary: "Il concorso si concluderà il 30 novembre 2026." }), NOW)).toBeNull();
  });

  it("il vincitore come premio non chiude il concorso", () => {
    // Falso positivo misurato il 16/10/2026 sul feed Scontrino Felice: il
    // vincitore era il PREMIO, non l'annuncio che la gara era finita.
    expect(
      staleReason(
        item({
          title: "Concorso Caffè Borbone: vinci abbonamenti NOW e incontra il vincitore di X Factor 2026",
          publishedAt: "2026-10-09T06:07:00.000Z",
        }),
        NOW,
      ),
    ).toBeNull();
    // La chiusura vera invece si vede ancora.
    expect(staleReason(item({ summary: "A breve l'elenco dei vincitori sul sito." }), NOW)).toBe("concorso già chiuso");
    expect(staleReason(item({ summary: "I vincitori sono stati contattati." }), NOW)).toBe("concorso già chiuso");
  });

  it("un numero di modello non è un anno di edizione", () => {
    // Falso positivo misurato il 16/10/2026: "Philips Airfryer Serie 2000"
    // diventava "edizione chiusa (2000)" e faceva scartare un concorso vivo.
    expect(
      staleReason(
        item({
          title: "Concorso Sottilette: in palio friggitrici ad aria Philips",
          summary: "In palio una Philips Airfryer Serie 2000 da 6,2 litri. Scade il 30 novembre.",
          publishedAt: "2026-10-08T05:40:00.000Z",
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("scarta la pagina che non si aggiorna da mesi", () => {
    const vecchia = new Date(NOW.getTime() - (STALE_PAGE_DAYS + 1) * 86_400_000).toISOString();
    expect(staleReason(item({ publishedAt: vecchia }), NOW)).toBe(`pagina ferma da ${STALE_PAGE_DAYS + 1} giorni`);
    // Al limite non si scarta: meglio tenere un dubbio che perdere un concorso.
    const limite = new Date(NOW.getTime() - STALE_PAGE_DAYS * 86_400_000).toISOString();
    expect(staleReason(item({ publishedAt: limite }), NOW)).toBeNull();
  });

  it("fuori dalle fonti di elenco non pretende il segnale di concorso", () => {
    // Un feed di aggregatore porta concorsi per mestiere: il titolo può non
    // contenere nessuna parola di concorso e resta valido.
    expect(staleReason(item({ title: "Buoni spesa Esselunga da 100 euro" }), NOW)).toBeNull();
  });

  it("da un elenco pretende il segnale, ma la sezione conta", () => {
    // Conad: sotto \"collezioni e concorsi\" non basta la parola della sezione.
    expect(
      staleReason(
        item({
          title: "Merabiglie Disney",
          url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/merabiglie-disney",
          summary: "",
          publishedAt: "2026-09-04T00:00:00.000Z",
          fromListing: true,
        }),
        NOW,
      ),
    ).toBe("nessun segnale di concorso");

    // Eni: la sezione si chiama \"concorsi-premi\" e i concorsi hanno nomi di
    // premio, quindi il segnale lo dà la sezione.
    expect(
      staleReason(
        item({
          title: "Vola A Disneyland Paris",
          url: "https://piuinsieme.eni.com/programma-fedelta/concorsi-premi/vola-a-disneyland-paris.html",
          publishedAt: "2026-09-14T00:00:00.000Z",
          fromListing: true,
        }),
        NOW,
      ),
    ).toBeNull();

    // Le tassonomie di un elenco hanno nomi che iniziano con la parola della
    // cartella che le contiene: "concorsi-fotografici" sotto "concorsi-a-premi".
    expect(
      staleReason(
        item({
          title: "Concorsi Fotografici",
          url: "https://www.premieconcorsi.com/concorsi-a-premi/concorsi-fotografici/",
          fromListing: true,
        }),
        NOW,
      ),
    ).toBe("nessun segnale di concorso");

    // E quando è la pagina stessa a dirlo, è un concorso a prescindere.
    expect(
      staleReason(
        item({
          title: "Vincibici",
          url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/vincibici",
          publishedAt: "2026-09-08T00:00:00.000Z",
          fromListing: true,
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("applica lo stesso cancello a un item già in archivio", () => {
    expect(
      staleItemReason(
        {
          sourceId: "sitemap-conad",
          title: "Premia Te E Lambiente",
          url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/premia-te-e-lambiente",
          summary: "",
          publishedAt: "2025-07-02T00:00:00.000Z",
          deadline: null,
          kind: "contest",
        },
        NOW,
      ),
    ).toBe("pagina ferma da 471 giorni");
    // Per una fonte che non è più in configurazione vale la firma dell'item:
    // titolo di slug e nessun testo.
    expect(
      staleItemReason(
        {
          sourceId: "fonte-sparita",
          title: "Tazzine Creeper",
          url: "https://www.esempio.it/promo/tazzine-creeper",
          summary: "",
          publishedAt: null,
          deadline: null,
          kind: "contest",
        },
        NOW,
      ),
    ).toBe("nessun segnale di concorso");
  });

  it("le offerte invecchiano prima dei concorsi", () => {
    // Un coupon non dichiara quasi mai una scadenza: la sua vita si misura dalla
    // pubblicazione, ed è corta (COUPON_TTL_DAYS). Mezzo anno dopo la sua data di
    // pubblicazione una pagina di concorso è ancora in tempo, un buono sconto no.
    const vecchio = new Date(NOW.getTime() - (COUPON_TTL_DAYS + 10) * 86_400_000).toISOString();
    expect(
      staleReason(item({ kind: "coupon", title: "Buono sconto Novi", publishedAt: vecchio }), NOW),
    ).toBe(`offerta vecchia (${COUPON_TTL_DAYS + 10} giorni)`);
    // Lo stesso item come concorso passa: la regola è del coupon.
    expect(staleReason(item({ title: "Buono sconto Novi", publishedAt: vecchio }), NOW)).toBeNull();
    // Senza data di pubblicazione non si giudica: "non lo so" non è una prova.
    expect(staleReason(item({ kind: "coupon", title: "Buono sconto Novi" }), NOW)).toBeNull();
    // E una scadenza futura salva comunque l'offerta, come i concorsi.
    expect(
      staleReason(item({ kind: "coupon", publishedAt: vecchio, deadline: "2026-11-30" }), NOW),
    ).toBeNull();
  });
});

describe("cancello · pagine indice", () => {
  it("riconosce la cartella che contiene altre pagine raccolte", () => {
    const urls = [
      "https://www.esempio.it/concorsi-a-premi/",
      "https://www.esempio.it/concorsi-a-premi/concorsi-a-codice/",
      "https://www.esempio.it/concorsi-a-premi/concorsi-a-quiz/",
      "https://www.esempio.it/concorsi-a-premi/concorsi-fotografici/",
    ];
    expect([...indexPageUrls(urls)]).toEqual(["https://www.esempio.it/concorsi-a-premi/"]);
  });

  it("non scarta il concorso che ha una sola sottopagina", () => {
    // Regolamento e form sono figli legittimi: con un solo figlio la pagina
    // madre resta un concorso.
    const urls = [
      "https://www.brand.it/promozioni/vinciwonka2026",
      "https://www.brand.it/promozioni/vinciwonka2026/regolamento",
    ];
    expect(indexPageUrls(urls).size).toBe(0);
  });

  it("non tocca URL che si somigliano solo per prefisso di testo", () => {
    const urls = [
      "https://www.brand.it/promozioni/vinci-auto",
      "https://www.brand.it/promozioni/vinci-auto-e-moto",
      "https://www.brand.it/promozioni/vinci-casa",
    ];
    expect(indexPageUrls(urls).size).toBe(0);
  });

  it("lo stesso URL elencato due volte non è un figlio di sé stesso", () => {
    // Le sitemap possono ripetere una pagina con lastmod diversi (Eurospin,
    // 17/10/2026). Prima ogni copia contava le altre come figlie e TUTTE le 20
    // pagine lette finivano scartate come "pagina indice".
    const urls = [
      "https://www.eurospin.it/concorso-bluey/",
      "https://www.eurospin.it/concorso-bluey/",
      "https://www.eurospin.it/concorso-bluey",
    ];
    expect(indexPageUrls(urls).size).toBe(0);
  });

  it("conta i figli anche quando l'elenco arriva disordinato", () => {
    // L'ordinamento interno è un'ottimizzazione: non deve cambiare il verdetto.
    const urls = [
      "https://www.esempio.it/concorsi/concorso-b/",
      "https://www.esempio.it/concorsi/",
      "https://www.esempio.it/concorsi/concorso-a/",
      "https://www.esempio.it/altro/",
    ];
    expect([...indexPageUrls(urls)]).toEqual(["https://www.esempio.it/concorsi/"]);
  });
});
