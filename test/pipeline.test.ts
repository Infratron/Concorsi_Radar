import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../src/db/memory.ts";
import { dueSources, runIngest, type IngestSummary } from "../src/pipeline.ts";
import { DIGEST_MAX_ITEMS, sendDigests, sendInstantAlerts } from "../src/telegram/digest.ts";
import { defaultFilters } from "../src/filters.ts";
import { MAX_MESSAGE_CHARS } from "../src/telegram/api.ts";
import type { TelegramClient } from "../src/telegram/api.ts";
import type { FetchLike, Prefs, SourceRow } from "../src/types.ts";

/**
 * Test end-to-end del percorso reale: due fonti RSS finte → ingestione →
 * deduplica cross-fonte → arricchimento → punteggio → notifiche Telegram.
 * Nessuna rete, nessun invio vero: Telegram è uno stub che registra i messaggi.
 */

/** 16/10/2026 12:00 UTC = 14:00 a Roma: fuori dalla fascia di silenzio. */
const NOW = new Date("2026-10-16T12:00:00.000Z");
const CHAT = 4242;
const PUBDATE = "Fri, 16 Oct 2026 08:00:00 +0200";

function source(id: string, name: string, url: string): SourceRow {
  return {
    id, name, kind: "rss", url, category: "online", tags: ["aggregatore"], cadenceMin: 15, enabled: true,
    etag: null, lastModified: null, lastRunAt: null, lastOkAt: null, failStreak: 0,
  };
}

function rssFeed(items: { title: string; link: string; description: string }[]): string {
  const body = items
    .map(
      (item) =>
        `<item><title><![CDATA[${item.title}]]></title><link>${item.link}</link>` +
        `<description><![CDATA[${item.description}]]></description><pubDate>${PUBDATE}</pubDate></item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Test</title>\n${body}\n</channel></rss>`;
}

function fetcherFor(pages: Record<string, string>): FetchLike {
  return async (input: string) => {
    const page = pages[input];
    if (page === undefined) return new Response("not found", { status: 404 });
    return new Response(page, { status: 200, headers: { "content-type": "application/rss+xml" } });
  };
}

function stubTelegram(): { tg: TelegramClient; sent: string[]; byChat: Record<number, string[]> } {
  const sent: string[] = [];
  const byChat: Record<number, string[]> = {};
  const tg = {
    async sendMessage(chatId: number, text: string) {
      sent.push(text);
      (byChat[chatId] ??= []).push(text);
      return { ok: true, messageId: sent.length, error: null, retryAfter: null };
    },
    async editMessageText() {
      return { ok: true, messageId: null, error: null, retryAfter: null };
    },
    async answerCallbackQuery() {
      return { ok: true, messageId: null, error: null, retryAfter: null };
    },
  } as unknown as TelegramClient;
  return { tg, sent, byChat };
}

/** Le due fonti condividono UN concorso (Barilla) scritto in modo diverso. */
const PAGES: Record<string, string> = {
  "https://a.example/feed": rssFeed([
    {
      title: "In palio una Fiat Panda con il concorso Barilla, scade il 25 ottobre 2026",
      link: "https://a.example/barilla",
      description:
        "Concorso gratuito senza obbligo di acquisto: basta iscriversi sul sito. In palio una Fiat Panda.",
    },
    {
      title: "Concorso Findus: 1000 euro di buoni spesa con scontrino",
      link: "https://a.example/findus",
      description: "Acquisto obbligatorio: serve lo scontrino. Scade il 20 dicembre 2026.",
    },
    {
      title: "Vinci un gadget con il codice sulla confezione",
      link: "https://a.example/gadget",
      description: "Confezione speciale, premi in omaggio.",
    },
  ]),
  "https://b.example/feed": rssFeed([
    {
      title: "Scontrino Felice - In palio una Fiat Panda con il concorso Barilla",
      link: "https://b.example/barilla",
      description: "Concorso gratuito senza obbligo di acquisto. In palio una Fiat Panda.",
    },
    {
      title: "Vinci una vacanza in Sardegna con il concorso Nutella",
      link: "https://b.example/nutella",
      description: "Concorso a premi. Scade il 30 novembre 2026.",
    },
  ]),
};

/**
 * Due fonti controllate: niente sintesi dalla config, così i test sono ripetibili.
 * Il budget di CPU è alto apposta: qui misuriamo la logica della pipeline, non il
 * tempo; il freno ha il suo test dedicato più sotto.
 */
const SOLO_FONTI_DEL_TEST = { maxSources: 2, includeSynthesized: false, cpuBudgetMs: 1000 } as const;
/** Stessa cosa per i test a una sola fonte. */
const UNA_FONTE_DEL_TEST = { maxSources: 1, includeSynthesized: false, cpuBudgetMs: 1000 } as const;

function prefs(minScoreInstant: number): Prefs {
  return {
    chatId: CHAT,
    active: true,
    weights: {},
    minScoreInstant,
    quietHours: "23-7",
    digestHours: [8, 19],
    filters: defaultFilters(),
  };
}

describe("pipeline · ingestione e deduplica cross-fonte", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = createMemoryStore();
    store.seedSources([source("fonte-a", "Aggregatore A", "https://a.example/feed"), source("fonte-b", "Scontrino Felice · concorsi con acquisto", "https://b.example/feed")]);
    await store.upsertPrefs(prefs(200));
  });

  function deps() {
    return { store, fetcher: fetcherFor(PAGES), ai: null };
  }

  it("ingestisce le due fonti e unisce il concorso ripetuto", async () => {
    const summary: IngestSummary = await runIngest(deps(), NOW, SOLO_FONTI_DEL_TEST);

    expect(summary.sourcesDue).toBe(2);
    expect(summary.sourcesOk).toBe(2);
    expect(summary.sourcesFail).toBe(0);
    expect(summary.itemsSeen).toBe(5);
    expect(summary.itemsNew).toBe(4);
    expect(summary.duplicates).toBe(1);

    const items = await store.queryItems({ limit: 50, orderBy: "score" });
    expect(items).toHaveLength(4);

    const barilla = items.filter((item) => item.title.toLowerCase().includes("barilla"));
    expect(barilla).toHaveLength(1);
    expect(barilla[0].clusterId).toBe(barilla[0].id);
    expect(barilla[0].title).not.toContain("Scontrino Felice");
    expect(barilla[0].deadline).toBe("2026-10-25");
    expect(barilla[0].score).toBeGreaterThanOrEqual(80);
  });

  it("registra la vista di ogni concorso e di ogni fonte, una volta sola", async () => {
    await runIngest(deps(), NOW, SOLO_FONTI_DEL_TEST);

    // Una riga per (concorso, fonte): 5 item visti, di cui uno duplicato.
    const viste = await store.listSightings("2026-01-01T00:00:00.000Z");
    expect(viste).toHaveLength(5);
    expect(viste.filter((vista) => vista.sourceId === "fonte-a")).toHaveLength(3);
    expect(viste.filter((vista) => vista.sourceId === "fonte-b")).toHaveLength(2);
    expect(viste.every((vista) => vista.kept)).toBe(true);
    expect(viste.every((vista) => vista.seenAt === NOW.toISOString())).toBe(true);

    // La copia dell'aggregatore punta alla STESSA riga del concorso: è quello che
    // rende confrontabili le due viste di Barilla.
    const barilla = (await store.queryItems({ limit: 50 })).find((item) => item.title.toLowerCase().includes("barilla"));
    expect(barilla).toBeDefined();
    expect((await store.listItemSightings(barilla!.id))).toHaveLength(2);

    // Il giro successivo rivede gli stessi item: nessuna vista in più.
    await runIngest(deps(), new Date(NOW.getTime() + 15 * 60 * 1000), SOLO_FONTI_DEL_TEST);
    expect(await store.listSightings("2026-01-01T00:00:00.000Z")).toHaveLength(5);
  });

  it("al giro successivo non crea più nulla (chiavi già viste)", async () => {
    await runIngest(deps(), NOW, SOLO_FONTI_DEL_TEST);
    const secondo = await runIngest(deps(), new Date(NOW.getTime() + 15 * 60 * 1000), SOLO_FONTI_DEL_TEST);

    expect(secondo.itemsNew).toBe(0);
    expect(secondo.duplicates).toBe(5);
    expect(await store.queryItems({ limit: 50 })).toHaveLength(4);
  });

  it("segnala una fonte che fallisce 3 volte di fila, una sola volta", async () => {
    // 404 e non 5xx: un errore non ritentabile, così il test non aspetta il backoff.
    const rotto: FetchLike = async () => new Response("boom", { status: 404 });
    const depsRot = { store, fetcher: rotto, ai: null };

    const primo = await runIngest(depsRot, NOW, SOLO_FONTI_DEL_TEST);
    expect(primo.sourcesFail).toBe(2);
    expect(primo.deadSources).toEqual([]);

    await runIngest(depsRot, new Date(NOW.getTime() + 15 * 60 * 1000), SOLO_FONTI_DEL_TEST);
    const terzo = await runIngest(depsRot, new Date(NOW.getTime() + 30 * 60 * 1000), SOLO_FONTI_DEL_TEST);

    expect(terzo.sourcesFail).toBe(2);
    expect(terzo.deadSources.sort()).toEqual(["fonte-a", "fonte-b"]);

    const quarto = await runIngest(depsRot, new Date(NOW.getTime() + 45 * 60 * 1000), SOLO_FONTI_DEL_TEST);
    expect(quarto.deadSources).toEqual([]);
  });
});

describe("pipeline · freno di budget CPU", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = createMemoryStore();
    store.seedSources([
      source("fonte-a", "Aggregatore A", "https://a.example/feed"),
      source("fonte-b", "Scontrino Felice · concorsi con acquisto", "https://b.example/feed"),
    ]);
    await store.upsertPrefs(prefs(200));
  });

  const deps = () => ({ store, fetcher: fetcherFor(PAGES), ai: null });

  it("con il budget già finito rimanda tutte le fonti al giro successivo", async () => {
    const summary = await runIngest(deps(), NOW, {
      maxSources: 2,
      includeSynthesized: false,
      cpuBudgetMs: -1,
    });

    expect(summary.sourcesDue).toBe(2);
    expect(summary.sourcesOk).toBe(0);
    expect(summary.deferred).toBe(2);
    expect(summary.notes.filter((nota) => nota.includes("budget CPU esaurito"))).toHaveLength(2);
    expect(await store.queryItems({ limit: 10 })).toHaveLength(0);
  });

  it("la prima fonte parte sempre: un budget a zero non affama l'esecuzione", async () => {
    const summary = await runIngest(deps(), NOW, {
      maxSources: 2,
      includeSynthesized: false,
      cpuBudgetMs: 0,
    });

    expect(summary.sourcesDue).toBe(2);
    expect(summary.sourcesOk).toBeGreaterThanOrEqual(1);
  });

  it("a budget finito a metà fonte rimanda la coda invece di interrompere il giro", async () => {
    // Budget praticamente nullo: il primo item passa, il resto resta al giro dopo.
    const summary = await runIngest(deps(), NOW, {
      maxSources: 1,
      includeSynthesized: false,
      cpuBudgetMs: 0.0001,
    });

    expect(summary.sourcesOk).toBe(1);
    expect(summary.itemsSeen).toBe(1);
    expect(summary.deferred).toBe(2);
    expect(summary.notes.some((nota) => nota.includes("item rimandati"))).toBe(true);
    // Il giro si chiude regolarmente e ha archiviato solo l'item che ha lavorato.
    expect(await store.queryItems({ limit: 50 })).toHaveLength(1);
  });
});

describe("pipeline · rumore delle fonti news", () => {
  it("scarta le notizie che non parlano di concorsi a premi", async () => {
    const store = createMemoryStore();
    const news = source("fonte-news", "Google News · concorso a premi", "https://n.example/feed");
    news.kind = "news";
    store.seedSources([news]);
    await store.upsertPrefs(prefs(200));

    await runIngest(
      {
        store,
        ai: null,
        fetcher: fetcherFor({
          "https://n.example/feed": rssFeed([
            // Casi reali osservati nella prova sulle fonti live.
            {
              title: "PlayStation Plus Extra/Premium, ecco i nuovi giochi di ottobre 2026!",
              link: "https://n.example/playstation",
              description: "Sono stati annunciati i nuovi giochi del catalogo.",
            },
            {
              title: "Women, Inter-Parma all'Arena Civica domenica 18 ottobre",
              link: "https://n.example/inter",
              description: "Calcio femminile, biglietti e orari.",
            },
            {
              title: "Concorso Condor Tailspotting: vinci un volo per il Messico per 2 persone",
              link: "https://n.example/condor",
              description: "In palio un volo per due persone. Scade il 19 ottobre 2026.",
            },
          ]),
        }),
      },
      NOW,
      UNA_FONTE_DEL_TEST,
    );

    const items = await store.queryItems({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("Condor");
    // Una notizia è un ARTICOLO: il link porta al giornale, non al concorso,
    // quindi va nella sezione news e non tra i concorsi su cui si partecipa.
    expect(items[0].kind).toBe("news");
  });

  it("non filtra gli aggregatori, che parlano di concorsi per mestiere", async () => {
    const store = createMemoryStore();
    store.seedSources([source("fonte-a", "Aggregatore A", "https://a.example/feed")]);
    await store.upsertPrefs(prefs(200));

    await runIngest(
      {
        store,
        ai: null,
        fetcher: fetcherFor({
          "https://a.example/feed": rssFeed([
            { title: "Concorso Findus: 1000 euro di buoni spesa", link: "https://a.example/f", description: "Scade il 20 dicembre 2026." },
          ]),
        }),
      },
      NOW,
      UNA_FONTE_DEL_TEST,
    );

    const items = await store.queryItems({ limit: 10 });
    expect(items).toHaveLength(1);
    // Un aggregatore pubblica una pagina per concorso: quella pagina è il
    // concorso, non un articolo che ne parla.
    expect(items[0].kind).toBe("contest");
  });
});

describe("pipeline · concorsi e contenitori", () => {
  it("la tassonomia di una cartella di concorsi entra come articolo", async () => {
    const store = createMemoryStore();
    const listino = source("premieconcorsi", "Premi e Concorsi", "https://www.premieconcorsi.com/sitemap.xml");
    listino.kind = "sitemap";
    listino.includePattern = "concorsi-a-premi/";
    store.seedSources([listino]);
    await store.upsertPrefs(prefs(200));

    await runIngest(
      {
        store,
        ai: null,
        fetcher: fetcherFor({
          "https://www.premieconcorsi.com/sitemap.xml": sitemap([
            // Il caso reale dell'archivio: in chat compariva come un concorso
            // dal titolo "A Partecipazione Gratuita".
            { loc: "https://www.premieconcorsi.com/concorsi-a-premi/a-partecipazione-gratuita", lastmod: "2026-10-15" },
            // Il concorso vero, appeso alla stessa cartella.
            { loc: "https://www.premieconcorsi.com/concorsi-a-premi/concorso-lievital", lastmod: "2026-10-15" },
          ]),
        }),
      },
      NOW,
      UNA_FONTE_DEL_TEST,
    );

    const items = await store.queryItems({ limit: 10 });
    const perTitolo = new Map(items.map((row) => [row.title, row.kind]));
    expect(perTitolo.get("A Partecipazione Gratuita")).toBe("news");
    expect(perTitolo.get("Concorso Lievital")).toBe("contest");

    // E la chat li tiene separati: la sezione concorsi non mostra la tassonomia.
    const concorsi = await store.queryItems({ kinds: ["contest"], limit: 10 });
    expect(concorsi.map((row) => row.title)).toEqual(["Concorso Lievital"]);
  });

  it("lo stesso concorso da sitemap e feed resta una riga sola, col nome migliore", async () => {
    // Il caso reale di Scontrino Felice: la sitemap dà lo slug, il feed il titolo
    // completo, e le due fonti parlano degli stessi URL. Prima vinceva quella che
    // capitava per prima, quindi in chat poteva restare il nome mozzo.
    const store = createMemoryStore();
    const listino = source("scontrinofelice-sitemap", "Sitemap · Scontrino Felice", "https://www.scontrinofelice.it/sitemap_index.xml");
    listino.kind = "sitemap";
    listino.includePattern = "/concorsi-con-acquisto/";
    const feed = source("scontrinofelice-acquisto", "Scontrino Felice · concorsi con acquisto", "https://www.scontrinofelice.it/concorsi-con-acquisto/feed/");
    store.seedSources([listino, feed]);
    await store.upsertPrefs(prefs(200));

    const url = "https://www.scontrinofelice.it/concorsi-con-acquisto/concorso-lievital/";
    const pagine = {
      "https://www.scontrinofelice.it/sitemap_index.xml": sitemap([{ loc: url, lastmod: "2026-10-15" }]),
      "https://www.scontrinofelice.it/concorsi-con-acquisto/feed/": rssFeed([
        {
          title: "Concorso Lievital: vinci Forni e Scaldavivande",
          link: url,
          description: "Concorso con acquisto: scade il 20 dicembre 2026. In palio forni e scaldavivande.",
        },
      ]),
    };

    const primo = await runIngest({ store, ai: null, fetcher: fetcherFor(pagine) }, NOW, { maxSources: 2, includeSynthesized: false, cpuBudgetMs: 1000 });
    const items = await store.queryItems({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Concorso Lievital: vinci Forni e Scaldavivande");
    expect(primo.duplicates).toBe(1);
    expect(primo.itemsNew).toBe(1);

    // Al giro dopo sono tutti duplicati, e non nasce nessuna seconda riga.
    const secondo = await runIngest({ store, ai: null, fetcher: fetcherFor(pagine) }, new Date(NOW.getTime() + 1_800_000), { maxSources: 2, includeSynthesized: false, cpuBudgetMs: 1000 });
    expect(secondo.itemsNew).toBe(0);
    expect(secondo.duplicates).toBe(2);
    expect(await store.queryItems({ limit: 10 })).toHaveLength(1);
  });
});

describe("pipeline · notifiche", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = createMemoryStore();
    store.seedSources([source("fonte-a", "Aggregatore A", "https://a.example/feed"), source("fonte-b", "Scontrino Felice · concorsi con acquisto", "https://b.example/feed")]);
    await runIngest({ store, fetcher: fetcherFor(PAGES), ai: null }, NOW, SOLO_FONTI_DEL_TEST);
  });

  it("il digest elenca i concorsi una volta sola e non si ripete", async () => {
    await store.upsertPrefs(prefs(200));
    const { tg, sent } = stubTelegram();

    const primo = await sendDigests({ store, tg, now: NOW });
    expect(primo.chats).toBe(1);
    expect(primo.messages).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBe(primo.messages);

    const testo = sent.join("\n");
    for (const message of sent) expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    // Maiuscolo: la forma minuscola è dentro l'URL, non nel titolo.
    expect(testo.match(/Barilla/g) ?? []).toHaveLength(1);
    expect(testo.match(/Findus/g) ?? []).toHaveLength(1);
    // Nessun item chiude entro 7 giorni: le sezioni piene sono Alto valore e Altri.
    expect(testo).toContain("🔥 Alto valore");
    expect(testo).toContain("📋 Altri");
    expect(testo).not.toContain("⏳ In scadenza");

    const secondo = await sendDigests({ store, tg, now: new Date(NOW.getTime() + 60 * 60 * 1000) });
    expect(secondo.messages).toBe(0);
    expect(sent).toHaveLength(primo.messages);
  });

  it("manda un istantaneo solo per l'alto valore e non lo ripete nel digest", async () => {
    await store.upsertPrefs(prefs(80));
    const { tg, sent } = stubTelegram();

    const istantanei = await sendInstantAlerts({ store, tg, now: NOW });
    expect(istantanei.sent).toBeGreaterThanOrEqual(1);
    expect(istantanei.sent).toBeLessThanOrEqual(2);
    expect(sent.some((message) => message.includes("Fiat Panda"))).toBe(true);

    sent.length = 0;
    await sendDigests({ store, tg, now: new Date(NOW.getTime() + 30 * 60 * 1000) });
    const digest = sent.join("\n");
    expect(digest).not.toContain("Fiat Panda");
    expect(digest).toContain("Findus");
  });

  it("con più di otto concorsi nuovi il digest taglia e rinvia a /oggi", async () => {
    const stores = createMemoryStore();
    stores.seedSources([source("fonte-c", "Fonte C", "https://c.example/feed")]);
    await stores.upsertPrefs(prefs(200));
    const titoli = Array.from({ length: 12 }, (_, index) => ({
      title: `Concorso brand${index} in palio un premio numero ${index}`,
      link: `https://c.example/${index}`,
      description: "Concorso a premi con gift card da 100 euro.",
    }));
    await runIngest(
      { store: stores, fetcher: fetcherFor({ "https://c.example/feed": rssFeed(titoli) }), ai: null },
      NOW,
      UNA_FONTE_DEL_TEST,
    );

    const { tg, sent } = stubTelegram();
    await sendDigests({ store: stores, tg, now: NOW });
    expect(sent.join("\n")).toContain(`e altri ${12 - DIGEST_MAX_ITEMS}`);
    expect(sent.join("\n").match(/brand\d+/g) ?? []).toHaveLength(DIGEST_MAX_ITEMS);
  });
});

describe("pipeline · due utenti", () => {
  const AMICA = 777;

  it("consegne e soglie sono per chat: ciò che ignori tu resta per l'altra persona", async () => {
    const store = createMemoryStore();
    store.seedSources([source("fonte-a", "Aggregatore A", "https://a.example/feed")]);
    await store.upsertPrefs(prefs(80));
    await store.upsertPrefs({ ...prefs(80), chatId: AMICA, minScoreInstant: 200 });

    await runIngest(
      { store, fetcher: fetcherFor(PAGES), ai: null },
      NOW,
      UNA_FONTE_DEL_TEST,
    );

    // Uno dei due scarta un concorso prima del digest.
    const findus = (await store.queryItems({ limit: 10 })).find((item) => item.title.includes("Findus"));
    expect(findus).toBeDefined();
    await store.recordDelivery(CHAT, findus!.id, "ignored", NOW.toISOString());

    const { tg, byChat } = stubTelegram();
    const istantanei = await sendInstantAlerts({ store, tg, now: NOW });
    // Snapshot prima del digest: anche i digest arrivano nella stessa raccolta.
    const istantaneiMiei = [...(byChat[CHAT] ?? [])];
    const istantaneiAmica = [...(byChat[AMICA] ?? [])];
    const digest = await sendDigests({ store, tg, now: new Date(NOW.getTime() + 30 * 60 * 1000) });

    // Soglia bassa per l'utente principale, alta per l'amica: un solo istantaneo.
    expect(istantanei.sent).toBe(1);
    expect(istantaneiMiei.join("\n")).toContain("Fiat Panda");
    expect(istantaneiAmica).toEqual([]);

    // Entrambe le chat ricevono il digest, con contenuti diversi.
    expect(digest.chats).toBe(2);
    // Solo i messaggi di digest: gli istantanei sono in testa alla raccolta.
    const mio = (byChat[CHAT] ?? []).slice(istantaneiMiei.length).join("\n");
    const suo = (byChat[AMICA] ?? []).slice(istantaneiAmica.length).join("\n");

    expect(mio).not.toContain("Fiat Panda"); // già arrivato come istantaneo
    expect(mio).not.toContain("Findus"); // scartato da me
    expect(mio).toContain("gadget");

    expect(suo).toContain("Fiat Panda"); // per lei è ancora nuovo
    expect(suo).toContain("Findus"); // la mia scelta non la penalizza
    expect(suo).toContain("gadget");
  });

  it("i filtri personali valgono anche nelle notifiche, e solo per la chat che li ha messi", async () => {
    const store = createMemoryStore();
    store.seedSources([
      source("fonte-a", "Aggregatore A", "https://a.example/feed"),
      source("fonte-b", "Aggregatore B", "https://b.example/feed"),
    ]);
    // Io: soglia altissima, quindi nessun avviso immediato e digest completo.
    await store.upsertPrefs(prefs(200));
    // Lei: niente viaggi e solo concorsi senza obbligo di acquisto.
    await store.upsertPrefs({
      ...prefs(80),
      chatId: AMICA,
      filters: { ...defaultFilters(), mutedTags: ["viaggio"], freeOnly: true },
    });

    await runIngest({ store, fetcher: fetcherFor(PAGES), ai: null }, NOW, {
      maxSources: 2, includeSynthesized: false, cpuBudgetMs: 1000,
    });

    const { tg, byChat } = stubTelegram();
    await sendInstantAlerts({ store, tg, now: NOW });
    await sendDigests({ store, tg, now: new Date(NOW.getTime() + 30 * 60 * 1000) });

    const mio = (byChat[CHAT] ?? []).join("\n");
    const suo = (byChat[AMICA] ?? []).join("\n");

    // Io non ho messo filtri: arrivano il viaggio in Sardegna e la spesa con scontrino.
    expect(mio).toContain("Nutella");
    expect(mio).toContain("Findus");

    // A lei no: il viaggio è un tipo che ha spento, la spesa chiede l'acquisto.
    expect(suo).not.toContain("Nutella");
    expect(suo).not.toContain("Findus");
    // Il gratuito invece le arriva: il suo filtro non è una gabbia.
    expect(suo).toContain("Barilla");
    // E la promo che chiede il codice sulla confezione resta fuori: "solo senza
    // acquisto" vuol dire senza acquisto, anche quando non è scritto "acquisto".
    expect(suo).not.toContain("gadget");
    expect((await store.getPrefs(CHAT))?.filters).toEqual(defaultFilters());
  });

  it("i pesi appresi restano separati per utente", async () => {
    const store = createMemoryStore();
    store.seedSources([source("fonte-a", "Aggregatore A", "https://a.example/feed")]);
    await store.upsertPrefs(prefs(80));
    await store.upsertPrefs({ ...prefs(80), chatId: AMICA, minScoreInstant: 200 });

    // La chat principale "ignora" il tag giftcard: l'amica mantiene i suoi pesi.
    await store.bumpWeights(CHAT, { giftcard: -3 });
    await store.bumpWeights(AMICA, { giftcard: 2 });

    expect((await store.getPrefs(CHAT))?.weights.giftcard).toBe(-3);
    expect((await store.getPrefs(AMICA))?.weights.giftcard).toBe(2);
  });
});

describe("pipeline · rotazione del carico", () => {
  it("una fonte con cadenza 60 minuti passa una volta ogni quattro tick", () => {
    const oraria = source("fonte-oraria", "Fonte oraria", "https://o.example/feed");
    oraria.cadenceMin = 60;
    const ogniQuindici = source("fonte-quindici", "Fonte quindici", "https://q.example/feed");

    let orariaDue = 0;
    for (let tick = 0; tick < 8; tick++) {
      const now = new Date(NOW.getTime() + tick * 15 * 60 * 1000);
      const due = dueSources([oraria, ogniQuindici], now, 10).map((item) => item.id);
      if (due.includes("fonte-oraria")) orariaDue++;
      expect(due).toContain("fonte-quindici");
    }
    expect(orariaDue).toBe(2);
  });

  it("non supera il tetto di fonti per esecuzione", () => {
    const molte = Array.from({ length: 10 }, (_, index) => source(`fonte-${index}`, `Fonte ${index}`, `https://f.example/${index}`));
    expect(dueSources(molte, NOW, 3)).toHaveLength(3);
  });

  it("ignora le fonti disabilitate", () => {
    const spenta = source("spenta", "Spenta", "https://s.example/feed");
    spenta.enabled = false;
    expect(dueSources([spenta], NOW, 5)).toEqual([]);
  });
});

describe("pipeline · raccolta completa (GitHub Actions)", () => {
  /**
   * Il caso di Actions: una cadenza fissa. Con `dueSources` un giro ogni 30
   * minuti cade sempre nello stesso slot, quindi metà fonti non verrebbe mai
   * letta. Questi test fissano sia il motivo sia la modalità `allSources`.
   */
  const PREMI = [
    "un buono spesa",
    "una bicicletta elettrica",
    "un weekend in montagna",
    "una macchina fotografica",
    "un robot da cucina",
  ];

  function fonteLarga(index: number): SourceRow {
    const row = source(`largo-${index}`, `Fonte larga ${index}`, `https://l${index}.example/feed`);
    row.cadenceMin = 30;
    return row;
  }

  const LARGHE = PREMI.map((_, index) => fonteLarga(index));
  const PAGINE_LARGHE: Record<string, string> = Object.fromEntries(
    LARGHE.map((row, index) => [
      row.url,
      rssFeed([
        {
          title: `Concorso largo ${index}: vinci ${PREMI[index]}`,
          link: `https://l${index}.example/item`,
          description: "Concorso gratuito senza obbligo di acquisto.",
        },
      ]),
    ]),
  );

  it("a cadenza fissa la rotazione ripropone sempre le stesse fonti", () => {
    const ids = (rows: SourceRow[]): string[] => rows.map((row) => row.id).sort();
    const primo = ids(dueSources(LARGHE, NOW, 10));
    const dopoTrenta = ids(dueSources(LARGHE, new Date(NOW.getTime() + 30 * 60 * 1000), 10));

    expect(primo.length).toBeGreaterThan(0);
    expect(primo.length).toBeLessThan(LARGHE.length);
    expect(dopoTrenta).toEqual(primo);
  });

  it("con allSources legge tutte le fonti abilitate in una sola esecuzione", async () => {
    const store = createMemoryStore();
    store.seedSources([...LARGHE]);

    const summary = await runIngest(
      { store, fetcher: fetcherFor(PAGINE_LARGHE), ai: null },
      NOW,
      { allSources: true, includeSynthesized: false, cpuBudgetMs: 1000 },
    );

    expect(summary.sourcesDue).toBe(LARGHE.length);
    expect(summary.sourcesOk).toBe(LARGHE.length);
    expect(summary.sourcesFail).toBe(0);
    expect(summary.deferred).toBe(0);

    const dopo = await store.getSources();
    expect(dopo.filter((row) => row.lastRunAt !== null)).toHaveLength(LARGHE.length);
  });

  it("con allSources il tetto resta e parte dalla fonte più trascurata", async () => {
    const store = createMemoryStore();
    store.seedSources([...LARGHE]);
    const vecchia = new Date(NOW.getTime() - 3_600_000).toISOString();
    for (const row of LARGHE) {
      await store.recordSourceRun(row.id, {
        ok: true, httpStatus: 200, etag: null, lastModified: null, error: null,
        now: row.id === "largo-0" ? vecchia : NOW.toISOString(),
      });
    }

    const summary = await runIngest(
      { store, fetcher: fetcherFor(PAGINE_LARGHE), ai: null },
      NOW,
      { allSources: true, maxSources: 1, includeSynthesized: false, cpuBudgetMs: 1000 },
    );

    expect(summary.sourcesDue).toBe(1);
    expect(summary.itemsSeen).toBe(1);
    const letta = (await store.getSources()).find((row) => row.lastRunAt === NOW.toISOString());
    expect(letta?.id).toBe("largo-0");
  });
});

/** Sitemap minimale: è il formato con cui i brand pubblicano anche i cataloghi. */
function sitemap(entries: { loc: string; lastmod?: string }[]): string {
  const body = entries
    .map((entry) => `<url><loc>${entry.loc}</loc>${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

/** Riga già in archivio, per provare i filtri su item inseriti prima di loro. */
function riga(partial: { sourceId: string; title: string; url: string; summary?: string; deadline?: string | null }) {
  return {
    sourceId: partial.sourceId,
    url: partial.url,
    urlKey: `key-${partial.url}`,
    simhash: "0123456789abcdef",
    title: partial.title,
    summary: partial.summary ?? "",
    publishedAt: null,
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    deadline: partial.deadline ?? null,
    prize: null,
    participation: null,
    prizeValue: 0.3,
    effort: 0.5,
    requiresPurchase: false,
    tags: [],
    score: 40,
    clusterId: null,
    status: "new" as const,
    aiUsed: false,
  };
}

describe("pipeline · solo concorsi ancora attivi", () => {
  it("da una sitemap entrano i concorsi vivi, non il catalogo", async () => {
    const store = createMemoryStore();
    const catalogo = source("brand-catalogo", "Brand · promozioni", "https://brand.example/sitemap.xml");
    catalogo.kind = "sitemap";
    catalogo.includePattern = "/promozioni/";
    store.seedSources([catalogo]);
    await store.upsertPrefs(prefs(200));

    const summary = await runIngest(
      {
        store,
        ai: null,
        fetcher: fetcherFor({
          "https://brand.example/sitemap.xml": sitemap([
            // La pagina di sezione è la cartella delle altre: un elenco, non un concorso.
            { loc: "https://brand.example/promozioni/", lastmod: "2026-10-01" },
            // Catalogo: tazze, nessun segnale di concorso.
            { loc: "https://brand.example/promozioni/tazze-creepers", lastmod: "2026-10-02" },
            // Edizione chiusa due anni fa.
            { loc: "https://brand.example/promozioni/vinci-natale-2024", lastmod: "2024-12-01" },
            // Il concorso vero, appena pubblicato.
            { loc: "https://brand.example/promozioni/vinci-natale-2026", lastmod: "2026-10-15" },
          ]),
        }),
      },
      NOW,
      UNA_FONTE_DEL_TEST,
    );

    const items = await store.queryItems({ limit: 10 });
    expect(items.map((row) => row.title)).toEqual(["Vinci Natale 2026"]);
    expect(summary.itemsNew).toBe(1);
    expect(summary.stale).toBe(3);
    expect(summary.notes.some((nota) => nota.includes("non attivi"))).toBe(true);

    // Anche gli scartati dal cancello lasciano la loro vista (kept=false): così il
    // vantaggio di tempistica può dirlo, invece di far sembrare che la fonte non
    // li avesse. Sono due e non tre: la pagina di sezione viene fermata prima, e
    // non è un concorso — registrarla come vista sarebbe un falso positivo.
    const scartati = (await store.listSightings("2026-01-01T00:00:00.000Z")).filter((vista) => !vista.kept);
    expect(scartati).toHaveLength(2);
    expect(scartati.every((vista) => vista.itemId === null)).toBe(true);
  });

  it("una notizia di un'edizione passata non entra nemmeno da un feed", async () => {
    const store = createMemoryStore();
    store.seedSources([source("fonte-a", "Aggregatore A", "https://a.example/feed")]);
    await store.upsertPrefs(prefs(200));

    const summary = await runIngest(
      {
        store,
        ai: null,
        fetcher: fetcherFor({
          "https://a.example/feed": rssFeed([
            {
              title: "Concorso Nutella 2024: vinci una bicicletta",
              link: "https://a.example/nutella-2024",
              description: "Partecipa con il codice sulle confezioni.",
            },
            {
              title: "Concorso Findus: 1000 euro di buoni spesa",
              link: "https://a.example/findus",
              description: "Scade il 20 dicembre 2026.",
            },
          ]),
        }),
      },
      NOW,
      UNA_FONTE_DEL_TEST,
    );

    const items = await store.queryItems({ limit: 10 });
    expect(items.map((row) => row.title)).toEqual(["Concorso Findus: 1000 euro di buoni spesa"]);
    expect(summary.stale).toBe(1);
  });

  it("il digest non annuncia quello che il cancello scarta", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs(10));
    // Archivio "ereditato": una pagina di catalogo entrata quando il cancello non
    // c'era ancora, e un concorso vero.
    await store.insertItem(
      riga({
        sourceId: "sitemap-conad",
        title: "Tazzine Creeper",
        url: "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/minecraft/tazze-creeper",
      }),
    );
    await store.insertItem(
      riga({
        sourceId: "fonte-a",
        title: "In palio una Fiat Panda con il concorso Barilla",
        url: "https://a.example/barilla",
        summary: "Concorso gratuito, scade il 30 novembre 2026.",
        deadline: "2026-11-30",
      }),
    );

    const { tg, sent } = stubTelegram();
    await sendDigests({ store, tg, now: NOW });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Fiat Panda");
    expect(sent.join("\n")).not.toContain("Tazzine");
  });
});
