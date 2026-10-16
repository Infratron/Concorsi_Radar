import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../src/db/memory.ts";
import type { ItemRow } from "../src/types.ts";
import { findStale, selectStale } from "../scripts/prune-stale.ts";

/**
 * Pulizia dell'archivio: la selezione è una funzione pura, quindi si prova senza
 * database e senza eseguire il comando. Le righe qui sotto sono i casi reali che
 * hanno reso necessaria la pulizia (sitemap Conad, promo chiuse, cataloghi).
 */

/** 20/11/2026, come gli altri test del progetto. */
const NOW = new Date("2026-11-20T10:00:00.000Z");

let counter = 0;

function item(overrides: Partial<ItemRow> = {}): ItemRow {
  const unique = ++counter;
  return {
    id: unique,
    sourceId: "premieconcorsi",
    kind: "contest",
    url: `https://esempio.it/concorso/${unique}`,
    urlKey: `key-${unique}`,
    simhash: "0123456789abcdef",
    title: "Concorso esempio",
    summary: "Partecipa con lo scontrino e vinci buoni spesa.",
    publishedAt: "2026-11-15T08:00:00.000Z",
    firstSeenAt: "2026-11-16T08:00:00.000Z",
    lastSeenAt: "2026-11-16T08:00:00.000Z",
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

/** Una pagina di elenco: titolo dallo slug, nessun testo. */
function listing(overrides: Partial<ItemRow> = {}): ItemRow {
  return item({ summary: "", ...overrides });
}

const attivo = item({
  title: "Concorso Barilla: vinci una Fiat Panda",
  url: "https://www.premieconcorsi.com/concorsi-a-premi/concorso-barilla/",
  deadline: "2026-12-25",
});

const edizioneVecchia = listing({
  sourceId: "sitemap-conad",
  title: "Premia Te E Lambiente 2024",
  url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/premia-te-e-lambiente-2024",
  publishedAt: "2025-07-02T00:00:00.000Z",
});

const paginaCatalogo = listing({
  sourceId: "sitemap-conad",
  title: "Merabiglie Disney",
  url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/merabiglie-disney",
  publishedAt: "2026-09-04T00:00:00.000Z",
});

const paginaFerma = listing({
  sourceId: "sitemap-sammontana",
  title: "Gusta E Vinci",
  url: "https://www.sammontana.it/novita-e-progetti/gusta-e-vinci.html",
  publishedAt: "2025-12-01T00:00:00.000Z",
});

const concorsoEni = listing({
  sourceId: "sitemap-eni",
  title: "Vola A Disneyland Paris",
  url: "https://piuinsieme.eni.com/programma-fedelta/concorsi-premi/vola-a-disneyland-paris.html",
  publishedAt: "2026-09-14T00:00:00.000Z",
});

const feedSenzaParoleChiave = item({
  title: "Buoni spesa Esselunga per i clienti fedeli",
  summary: "Iniziativa del supermercato riservata a chi ha la carta.",
});

describe("pulizia · cosa è un concorso ancora attivo", () => {
  it("non segnala niente quando è tutto a posto", () => {
    expect(selectStale([attivo, concorsoEni, feedSenzaParoleChiave], NOW)).toEqual([]);
  });

  it("segnala l'edizione vecchia, il catalogo e la pagina ferma da mesi", () => {
    const stale = selectStale(
      [attivo, edizioneVecchia, paginaCatalogo, paginaFerma, concorsoEni, feedSenzaParoleChiave],
      NOW,
    );

    expect(stale.map((entry) => entry.row.urlKey)).toEqual([
      edizioneVecchia.urlKey,
      paginaCatalogo.urlKey,
      paginaFerma.urlKey,
    ]);
    expect(stale[0]?.reason).toBe("edizione chiusa (2024)");
    expect(stale[1]?.reason).toBe("nessun segnale di concorso");
    expect(stale[2]?.reason).toBe("pagina ferma da 354 giorni");
  });

  it("una scadenza futura mette al riparo anche una pagina di catalogo", () => {
    expect(selectStale([{ ...paginaCatalogo, deadline: "2026-12-01" }], NOW)).toEqual([]);
  });

  it("le parole della sezione non salvano una pagina di catalogo", () => {
    // /carte-e-premi/ contiene "premi": se contasse, tutto il catalogo Conad
    // passerebbe per concorso. Conta invece la cartella che contiene la pagina:
    // "collezioni-e-concorsi" è un catalogo, "concorsi-premi" no.
    expect(selectStale([{ ...paginaCatalogo }], NOW)[0]?.reason).toBe("nessun segnale di concorso");
    expect(selectStale([{ ...concorsoEni }], NOW)).toEqual([]);
  });
});

describe("pulizia · dalla selezione alla cancellazione", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = createMemoryStore();
    for (const entry of [attivo, edizioneVecchia, paginaCatalogo, concorsoEni, feedSenzaParoleChiave]) {
      await store.insertItem(entry);
    }
  });

  it("segnala la pagina di sezione perché è la cartella di altre pagine dell'archivio", async () => {
    const store2 = createMemoryStore();
    const sezione = listing({
      sourceId: "sitemap-conad",
      title: "Collezioni E Concorsi",
      url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi",
      publishedAt: "2026-10-08T00:00:00.000Z",
    });
    const figli = [
      listing({
        sourceId: "sitemap-conad",
        title: "Vincibici",
        url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/vincibici",
        publishedAt: "2026-09-08T00:00:00.000Z",
      }),
      listing({
        sourceId: "sitemap-conad",
        title: "Vincigiro",
        url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/giro-d-italia-vincigiro",
        publishedAt: "2026-09-15T00:00:00.000Z",
      }),
    ];
    for (const entry of [sezione, ...figli]) await store2.insertItem(entry);

    const stale = await findStale(store2, NOW);
    expect(stale.map((entry) => entry.row.urlKey)).toEqual([sezione.urlKey]);
    expect(stale[0]?.reason).toBe("pagina indice");
  });

  it("legge solo gli item senza scadenza e trova gli stessi candidati della funzione pura", async () => {
    const stale = await findStale(store, NOW);
    expect(stale.map((entry) => entry.row.urlKey)).toEqual([edizioneVecchia.urlKey, paginaCatalogo.urlKey]);

    // Il concorso con scadenza non entra nemmeno nella query: 4 item su 5.
    expect((await store.queryItems({ withoutDeadline: true, limit: 50 })).length).toBe(4);
  });

  it("cancella solo i candidati segnalati, lasciando in archivio i concorsi attivi", async () => {
    const stale = await findStale(store, NOW);
    const deleted = await store.deleteItems(stale.map((entry) => entry.row.id));
    expect(deleted).toBe(2);

    const rimasti = (await store.queryItems({ limit: 50 })).map((entry) => entry.urlKey).sort();
    expect(rimasti).toEqual([attivo.urlKey, concorsoEni.urlKey, feedSenzaParoleChiave.urlKey].sort());
  });
});
