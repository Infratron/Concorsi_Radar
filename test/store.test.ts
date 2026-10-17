import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../src/db/memory.ts";
import { DUP_CANDIDATE_MAX_HAMMING, hammingHex, simhash } from "../src/lib/text.ts";
import { defaultFilters, filtersFor } from "../src/filters.ts";
import type { NewItem, SourceRow } from "../src/types.ts";

function makeSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "scontrinofelice-acquisto",
    name: "Scontrino Felice · concorsi con acquisto",
    kind: "rss",
    url: "https://www.scontrinofelice.it/concorsi-con-acquisto/feed/",
    category: "scontrino",
    tags: ["acquisto"],
    cadenceMin: 30,
    enabled: true,
    etag: null,
    lastModified: null,
    lastRunAt: null,
    lastOkAt: null,
    failStreak: 0,
    lastStatus: null,
    lastError: null,
    lastItems: 0,
    ...overrides,
  };
}

function makeItem(overrides: Partial<NewItem> = {}): NewItem {
  const title = overrides.title ?? "Concorso Esselunga buoni spesa 1000 euro con scontrino";
  return {
    sourceId: "scontrinofelice-acquisto",
    url: "https://www.scontrinofelice.it/concorsi/esselunga/",
    urlKey: "key-esselunga",
    simhash: simhash(title),
    title,
    summary: "Partecipa con lo scontrino e vinci buoni spesa.",
    publishedAt: null,
    firstSeenAt: "2026-10-16T08:00:00.000Z",
    lastSeenAt: "2026-10-16T08:00:00.000Z",
    deadline: "2026-11-30",
    prize: "10 buoni spesa da 100 euro",
    participation: "acquisto + scontrino",
    prizeValue: 0.9,
    effort: 0.3,
    requiresPurchase: true,
    tags: ["giftcard", "acquisto"],
    score: 70,
    clusterId: null,
    status: "new",
    aiUsed: false,
    ...overrides,
  };
}

describe("memory store · inserimento", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = createMemoryStore();
  });

  it("inserisce e segnala created=true, poi created=false sullo stesso urlKey", async () => {
    const first = await store.insertItem(makeItem());
    expect(first.created).toBe(true);
    expect(first.item.id).toBe(1);

    const second = await store.insertItem(makeItem({ url: "https://altro.example/esselunga" }));
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(1);
  });

  it("restituisce copie isolate: modificare l'item restituito non tocca lo store", async () => {
    const { item } = await store.insertItem(makeItem());
    item.title = "titolo manomesso";
    item.tags.push("inventato");
    const reloaded = await store.getItem(1);
    expect(reloaded?.title).toBe("Concorso Esselunga buoni spesa 1000 euro con scontrino");
    expect(reloaded?.tags).toEqual(["giftcard", "acquisto"]);
  });
});

describe("memory store · concorso o articolo", () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = createMemoryStore();
    // Il primo item non dichiara niente: deve restare un concorso.
    await store.insertItem(makeItem());
    await store.insertItem(
      makeItem({
        url: "https://esempio.it/articolo",
        urlKey: "key-articolo",
        title: "Ecco i 10 concorsi del mese",
        kind: "news",
      }),
    );
  });

  it("senza kind l'item è un concorso, con kind news è un articolo", async () => {
    expect((await store.getItem(1))?.kind).toBe("contest");
    expect((await store.getItem(2))?.kind).toBe("news");
  });

  it("filtra per tipo, e una lista vuota non filtra", async () => {
    expect((await store.queryItems({ kinds: ["news"] })).map((row) => row.id)).toEqual([2]);
    expect((await store.queryItems({ kinds: ["contest"] })).map((row) => row.id)).toEqual([1]);
    expect((await store.queryItems({ kinds: ["contest", "news"] }))).toHaveLength(2);
    expect((await store.queryItems({ kinds: [] }))).toHaveLength(2);
    expect(await store.countItems({ kinds: ["news"] })).toBe(1);
  });

  it("una patch sposta una riga da una sezione all'altra", async () => {
    await store.updateItem(1, { kind: "news" });
    expect((await store.getItem(1))?.kind).toBe("news");
    expect((await store.queryItems({ kinds: ["contest"] }))).toHaveLength(0);
  });
});

describe("memory store · deduplica", () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = createMemoryStore();
    await store.insertItem(makeItem());
  });

  const WINDOW = "2026-10-01T00:00:00.000Z";

  it("propone il candidato con urlKey identico", async () => {
    const candidates = await store.findDuplicateCandidates("key-esselunga", "ffffffffffffffff", WINDOW);
    expect(candidates.map((row) => row.id)).toEqual([1]);
  });

  it("propone il candidato con simhash vicino (stesso concorso su un'altra fonte)", async () => {
    const variant = "Concorso Esselunga buoni spesa 1000 euro con scontrino scadenza";
    const distance = hammingHex(simhash("Concorso Esselunga buoni spesa 1000 euro con scontrino"), simhash(variant));
    expect(distance).toBeLessThanOrEqual(DUP_CANDIDATE_MAX_HAMMING);

    const candidates = await store.findDuplicateCandidates("chiave-di-altra-fonte", simhash(variant), WINDOW);
    expect(candidates.map((row) => row.id)).toContain(1);
  });

  it("ordina i candidati dal più simile e rispetta il limite", async () => {
    const simile = "Concorso Esselunga buoni spesa 500 euro con scontrino";
    await store.insertItem({
      sourceId: "fonte-b", url: "https://b.example/simile", urlKey: "key-simile",
      simhash: simhash(simile), title: simile, summary: "", publishedAt: null,
      firstSeenAt: "2026-10-15T08:00:00.000Z", lastSeenAt: "2026-10-15T08:00:00.000Z",
      deadline: null, prize: null, participation: null, prizeValue: 0, effort: 0.5,
      requiresPurchase: false, tags: [], score: 0, clusterId: null, status: "new", aiUsed: false,
    });

    const exact = "Concorso Esselunga buoni spesa 1000 euro con scontrino";
    const candidates = await store.findDuplicateCandidates("key-nuovo", simhash(exact), WINDOW);
    expect(candidates[0].id).toBe(1);
    expect(candidates.map((row) => row.id)).toContain(2);

    const limited = await store.findDuplicateCandidates("key-nuovo", simhash(exact), WINDOW, 1);
    expect(limited).toHaveLength(1);
  });

  it("ignora gli item fuori dalla finestra sinceIso", async () => {
    const candidates = await store.findDuplicateCandidates(
      "chiave-x",
      simhash("Concorso Esselunga buoni spesa 1000 euro con scontrino scadenza"),
      "2027-01-01T00:00:00.000Z",
    );
    expect(candidates).toEqual([]);
  });

  it("touchItem aggiorna solo lastSeenAt e non crea un nuovo item", async () => {
    await store.touchItem(1, "2026-10-20T10:00:00.000Z");
    const items = await store.queryItems({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0].lastSeenAt).toBe("2026-10-20T10:00:00.000Z");
    expect(items[0].firstSeenAt).toBe("2026-10-16T08:00:00.000Z");
  });
});

describe("memory store · queryItems", () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = createMemoryStore();
    await store.insertItem(makeItem());
    await store.insertItem(
      makeItem({
        urlKey: "key-bici",
        url: "https://www.premieconcorsi.com/concorsi/bici/",
        title: "Vinci una bicicletta elettrica con il codice sul pacchetto di merendine",
        summary: "Concorso gratuito senza obbligo di acquisto.",
        deadline: "2026-12-31",
        score: 92,
        status: "saved",
        tags: ["elettronica"],
      }),
    );
    await store.insertItem(
      makeItem({
        urlKey: "key-caffe",
        url: "https://www.soldissimi.it/concorsi/caffe/",
        title: "Concorso caffe Illy vinci una macchina da caffe",
        summary: "Partecipa con tre scontrini.",
        deadline: null,
        score: 40,
      }),
    );
  });

  it("filtra per status, punteggio, keyword e scadenza", async () => {
    expect(await store.queryItems({ statuses: ["new"], limit: 10 })).toHaveLength(2);
    expect(await store.queryItems({ statuses: ["saved"], limit: 10 })).toHaveLength(1);
    expect(await store.queryItems({ minScore: 80, limit: 10 })).toHaveLength(1);
    expect(await store.queryItems({ keyword: "bicicletta", limit: 10 })).toHaveLength(1);
    expect(await store.queryItems({ keyword: "inesistente", limit: 10 })).toHaveLength(0);
    expect(await store.queryItems({ deadlineBefore: "2026-11-30", limit: 10 })).toHaveLength(1);
  });

  it("rispetta limit ed esclude gli id indicati", async () => {
    expect(await store.queryItems({ limit: 1 })).toHaveLength(1);
    expect(await store.queryItems({ excludeIds: [1, 2], limit: 10 })).toHaveLength(1);
    expect(await store.queryItems({ limit: 999 })).toHaveLength(3);
  });

  it("ordina per punteggio, per data e per scadenza (null in fondo)", async () => {
    const byScore = await store.queryItems({ orderBy: "score", limit: 10 });
    expect(byScore.map((item) => item.id)).toEqual([2, 1, 3]);

    const byFirstSeen = await store.queryItems({ orderBy: "first_seen", limit: 10 });
    expect(byFirstSeen).toHaveLength(3);

    const byDeadline = await store.queryItems({ orderBy: "deadline", limit: 10 });
    expect(byDeadline.map((item) => item.deadline)).toEqual(["2026-11-30", "2026-12-31", null]);
  });

  it("filtra anche per finestra temporale", async () => {
    const later = await store.queryItems({ since: "2027-01-01T00:00:00.000Z", limit: 10 });
    expect(later).toHaveLength(0);
    const wide = await store.queryItems({ since: "2026-01-01T00:00:00.000Z", limit: 10 });
    expect(wide).toHaveLength(3);
  });

  it("il filtro di validità toglie i coupon scaduti e lascia quelli senza data", async () => {
    // Un coupon senza validità dichiarata non si giudica (e resta), uno con la
    // validità passata non si può più spendere: è la differenza fra questo filtro
    // e deadlineAfter, che invece chiede una data e scarterebbe i più.
    await store.insertItem(
      makeItem({ urlKey: "key-coupon-vivo", url: "https://coupon.example/novi", kind: "coupon", deadline: null }),
    );
    await store.insertItem(
      makeItem({ urlKey: "key-coupon-domani", url: "https://coupon.example/lidl", kind: "coupon", deadline: "2026-10-17" }),
    );
    await store.insertItem(
      makeItem({ urlKey: "key-coupon-morto", url: "https://coupon.example/vecchio", kind: "coupon", deadline: "2026-10-15" }),
    );

    const vivi = await store.queryItems({ kinds: ["coupon"], deadlineNotBefore: "2026-10-16", limit: 10 });
    expect(vivi.map((row) => row.urlKey).sort()).toEqual(["key-coupon-domani", "key-coupon-vivo"]);
    expect(await store.countItems({ kinds: ["coupon"], deadlineNotBefore: "2026-10-16" })).toBe(2);
    // Il filtro non guarda il tipo: sui tre item del beforeEach (due concorsi con
    // scadenza e uno senza) toglie soltanto il coupon scaduto.
    expect(await store.queryItems({ deadlineNotBefore: "2026-10-16", limit: 10 })).toHaveLength(5);
  });

  it("setStatus e updateItem cambiano lo stato e i campi arricchiti", async () => {
    await store.updateItem(1, { score: 88, status: "sent", deadline: "2026-12-15", tags: ["giftcard", "gratis"] });
    const item = await store.getItem(1);
    expect(item?.score).toBe(88);
    expect(item?.status).toBe("sent");
    expect(item?.deadline).toBe("2026-12-15");
    expect(item?.tags).toEqual(["giftcard", "gratis"]);

    await store.setStatus(1, "won");
    expect((await store.getItem(1))?.status).toBe("won");
    expect(await store.getItem(4242)).toBeNull();
  });
});

describe("memory store · cancellazione degli item", () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = createMemoryStore();
    await store.insertItem(makeItem());
    await store.insertItem(
      makeItem({
        urlKey: "key-bici",
        url: "https://www.premieconcorsi.com/concorsi/bici/",
        title: "Vinci una bicicletta elettrica",
      }),
    );
    await store.recordDelivery(999, 1, "saved", "2026-10-16T09:00:00.000Z");
    await store.recordDelivery(999, 2, "digest", "2026-10-16T09:00:00.000Z");
  });

  it("cancella l'item e le sue consegne, lasciando in piedi il resto", async () => {
    expect(await store.deleteItems([1])).toBe(1);
    expect(await store.getItem(1)).toBeNull();
    expect(await store.isDelivered(999, 1, "saved")).toBe(false);
    expect(await store.listDeliveredItems(999, "saved")).toEqual([]);
    expect((await store.queryItems({ limit: 10 })).map((row) => row.id)).toEqual([2]);
    // La consegna dell'altro item non si tocca.
    expect(await store.isDelivered(999, 2, "digest")).toBe(true);
  });

  it("un id inesistente, o nessun id, non cancella niente", async () => {
    expect(await store.deleteItems([4242])).toBe(0);
    expect(await store.deleteItems([])).toBe(0);
    expect(await store.queryItems({ limit: 10 })).toHaveLength(2);
    expect(await store.isDelivered(999, 1, "saved")).toBe(true);
  });
});

describe("memory store · prefs, consegne e peso dei tag", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = createMemoryStore();
  });

  it("prefs assenti sono null, poi upsertPrefs le rende leggibili", async () => {
    expect(await store.getPrefs(999)).toBeNull();
    await store.upsertPrefs({
      chatId: 999,
      active: true,
      weights: { giftcard: 2 },
      minScoreInstant: 75,
      quietHours: "23-7",
      digestHours: [8, 19],
      instantAlerts: false,
      filters: defaultFilters(),
    });
    const prefs = await store.getPrefs(999);
    expect(prefs?.minScoreInstant).toBe(75);
    expect(prefs?.weights).toEqual({ giftcard: 2 });
    expect(prefs?.filters).toEqual(defaultFilters());
    expect(await store.listChats()).toEqual([999]);

    await store.upsertPrefs({ ...prefs!, active: false });
    expect(await store.listChats()).toEqual([]);
    expect((await store.getPrefs(999))?.active).toBe(false);
  });

  it("registra le consegne una volta sola e legge l'ultima per tipo", async () => {
    expect(await store.isDelivered(999, 1, "instant")).toBe(false);
    await store.recordDelivery(999, 1, "instant", "2026-10-16T08:00:00.000Z");
    await store.recordDelivery(999, 2, "digest", "2026-10-16T19:00:00.000Z");
    await store.recordDelivery(999, 3, "digest", "2026-10-17T08:00:00.000Z");

    expect(await store.isDelivered(999, 1, "instant")).toBe(true);
    expect(await store.lastDeliveryAt(999, "digest")).toBe("2026-10-17T08:00:00.000Z");
    expect(await store.lastDeliveryAt(999, "instant")).toBe("2026-10-16T08:00:00.000Z");
    expect(await store.lastDeliveryAt(999, "altro")).toBeNull();

    await store.recordDelivery(999, 1, "instant", "2026-10-17T09:00:00.000Z");
    expect(await store.lastDeliveryAt(999, "instant")).toBe("2026-10-17T09:00:00.000Z");
  });

  it("bumpWeights somma i delta, crea le prefs mancanti e limita a [-5, +5]", async () => {
    await store.bumpWeights(999, { giftcard: 3 });
    await store.bumpWeights(999, { giftcard: 3 });
    let prefs = await store.getPrefs(999);
    expect(prefs?.weights.giftcard).toBe(5);
    expect(prefs?.active).toBe(true);
    expect(prefs?.minScoreInstant).toBe(80);

    await store.bumpWeights(999, { acquisto: -10 });
    prefs = await store.getPrefs(999);
    expect(prefs?.weights.acquisto).toBe(-5);

    await store.bumpWeights(999, { giftcard: -2 });
    expect((await store.getPrefs(999))?.weights.giftcard).toBe(3);
  });
});

describe("memory store · fonti, run, ai e robots", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = createMemoryStore();
    store.seedSources([makeSource({ failStreak: 0 }), makeSource({ id: "vincimi", name: "Vincimi", kind: "rss", url: "https://www.vincimi.it/feed/" })]);
  });

  it("recordSourceRun tiene la storia e l'ultimo tentativo, che non coincidono", async () => {
    await store.recordSourceRun("scontrinofelice-acquisto", {
      ok: false, httpStatus: 500, etag: null, lastModified: null, error: "HTTP 500", items: 0,
      now: "2026-10-16T08:00:00.000Z",
    });
    let source = (await store.getSources()).find((s) => s.id === "scontrinofelice-acquisto");
    expect(source?.failStreak).toBe(1);
    expect(source?.lastOkAt).toBeNull();
    // L'ultimo tentativo si legge anche quando fallisce: è quello che la chat mostra.
    expect(source?.lastRunAt).toBe("2026-10-16T08:00:00.000Z");
    expect(source?.lastStatus).toBe(500);
    expect(source?.lastError).toBe("HTTP 500");
    expect(source?.lastItems).toBe(0);

    await store.recordSourceRun("scontrinofelice-acquisto", {
      ok: false, httpStatus: 500, etag: null, lastModified: null, error: "HTTP 500", items: 0,
      now: "2026-10-16T08:15:00.000Z",
    });
    source = (await store.getSources()).find((s) => s.id === "scontrinofelice-acquisto");
    expect(source?.failStreak).toBe(2);

    await store.recordSourceRun("scontrinofelice-acquisto", {
      ok: true, httpStatus: 200, etag: "W/abc", lastModified: "Thu, 16 Oct 2026 08:00:00 GMT", error: null,
      items: 3, now: "2026-10-16T08:30:00.000Z",
    });
    source = (await store.getSources()).find((s) => s.id === "scontrinofelice-acquisto");
    expect(source?.failStreak).toBe(0);
    expect(source?.lastOkAt).toBe("2026-10-16T08:30:00.000Z");
    expect(source?.etag).toBe("W/abc");
    expect(source?.lastModified).toBe("Thu, 16 Oct 2026 08:00:00 GMT");
    // L'errore vecchio non resta appeso: adesso l'ultimo tentativo è riuscito.
    expect(source?.lastStatus).toBe(200);
    expect(source?.lastError).toBeNull();
    expect(source?.lastItems).toBe(3);

    // Un id sconosciuto non deve esplodere.
    await store.recordSourceRun("assente", {
      ok: true, httpStatus: 200, etag: null, lastModified: null, error: null, items: 0,
      now: "2026-10-16T08:30:00.000Z",
    });
    expect(await store.getSources()).toHaveLength(2);
  });

  it("claimUpdate accetta un update_id una volta sola", async () => {
    expect(await store.claimUpdate(101, "2026-10-16T08:00:00.000Z")).toBe(true);
    expect(await store.claimUpdate(101, "2026-10-16T08:00:01.000Z")).toBe(false);
    expect(await store.claimUpdate(102, "2026-10-16T08:00:02.000Z")).toBe(true);
  });

  it("pagina con limit e offset senza saltare né ripetere righe", async () => {
    // Stesso punteggio e stessa data di inserimento per tutte: è il caso in cui,
    // senza un ultimo criterio unico, due pagine si sovrappongono.
    for (let index = 1; index <= 7; index++) {
      await store.insertItem(makeItem({ urlKey: `key-${index}`, url: `https://esempio.it/${index}`, title: `Concorso ${index}` }));
    }

    const prima = await store.queryItems({ limit: 3 });
    const seconda = await store.queryItems({ limit: 3, offset: 3 });
    const terza = await store.queryItems({ limit: 3, offset: 6 });
    expect(prima).toHaveLength(3);
    expect(seconda).toHaveLength(3);
    expect(terza).toHaveLength(1);

    const visti = [...prima, ...seconda, ...terza].map((row) => row.id);
    expect(new Set(visti).size).toBe(7);
    // Le righe a pari punteggio escono dalla più recente: il penultimo inserito
    // sta prima dell'ultimo solo se l'ordine non è stabile, quindi qui si
    // controlla l'ordine esatto.
    expect(visti).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it("ordina i chiusi per data di chiusura, i più recenti per primi", async () => {
    const chiusoDaPoco = await store.insertItem(
      makeItem({ urlKey: "key-a", url: "https://esempio.it/a", title: "Chiuso ieri", deadline: "2026-10-15", score: 40 }),
    );
    const chiusoDaTanto = await store.insertItem(
      makeItem({ urlKey: "key-b", url: "https://esempio.it/b", title: "Chiuso a settembre", deadline: "2026-09-01", score: 90 }),
    );
    const senzaScadenza = await store.insertItem(
      makeItem({ urlKey: "key-c", url: "https://esempio.it/c", title: "Senza scadenza", deadline: null, score: 100 }),
    );
    await store.insertItem(makeItem({ urlKey: "key-d", url: "https://esempio.it/d", title: "Ancora aperto", deadline: "2026-12-31" }));

    const chiusi = await store.queryItems({ deadlineBefore: "2026-10-16", orderBy: "deadline_desc", limit: 10 });
    expect(chiusi.map((row) => row.id)).toEqual([chiusoDaPoco.item.id, chiusoDaTanto.item.id]);
    // La riga senza scadenza resta fuori dal filtro, non "in fondo".
    expect(chiusi.map((row) => row.id)).not.toContain(senzaScadenza.item.id);
  });

  it("recordRun e recentRuns restituiscono i run più recenti per primi", async () => {
    await store.recordRun({ startedAt: "2026-10-16T08:00:00.000Z", trigger: "*/15 * * * *", sourcesOk: 2, sourcesFail: 0, itemsNew: 4, ms: 120, note: null, log: null });
    await store.recordRun({ startedAt: "2026-10-16T09:00:00.000Z", trigger: "*/15 * * * *", sourcesOk: 1, sourcesFail: 1, itemsNew: 2, ms: 200, note: "soldissimi: HTTP 429", log: "🧪 <b>Raccolta su GitHub</b> · 12:03" });
    const runs = await store.recentRuns(5);
    expect(runs).toHaveLength(2);
    expect(runs[0].startedAt).toBe("2026-10-16T09:00:00.000Z");
    expect(runs[0].note).toBe("soldissimi: HTTP 429");
  });

  it("il log sta con la sua esecuzione, e recentLogs lascia fuori chi non ne ha uno", async () => {
    // Il tick del Worker non raccoglie: non ha niente da raccontare, e senza
    // questo filtro 🧾 Log delle raccolte sarebbe pieno di righe vuote (novantasei
    // al giorno).
    await store.recordRun({ startedAt: "2026-10-16T08:00:00.000Z", trigger: "*/15 * * * *", sourcesOk: 0, sourcesFail: 0, itemsNew: 0, ms: 30, note: "tick", log: null });
    await store.recordRun({ startedAt: "2026-10-16T08:30:00.000Z", trigger: "actions", sourcesOk: 3, sourcesFail: 1, itemsNew: 9, ms: 800, note: "actions | 4 fonti", log: "🧪 <b>Raccolta su GitHub</b> · 10:30\n🔴 Soldissimi · HTTP 403" });
    await store.recordRun({ startedAt: "2026-10-16T09:00:00.000Z", trigger: "local", sourcesOk: 2, sourcesFail: 0, itemsNew: 1, ms: 500, note: "local | 2 fonti", log: "🧪 <b>Raccolta lanciata a mano</b> · 11:00" });

    expect((await store.recentRuns(5)).map((run) => run.log === null)).toEqual([false, false, true]);
    expect((await store.recentLogs(5)).map((run) => run.note)).toEqual(["local | 2 fonti", "actions | 4 fonti"]);
    // Il log si rilegge esattamente come è stato scritto: è testo, e in chat deve
    // arrivare con le sue righe (la fonte che non ha risposto è la riga che si sta
    // cercando quando si apre il log).
    const log = await store.recentLogs(5);
    expect(log[1].log).toContain("\n🔴 Soldissimi");
    expect(log).toHaveLength(2);
  });

  it("somma il consumo Workers AI del giorno", async () => {
    expect(await store.aiUsage("2026-10-16")).toBe(0);
    await store.addAiUsage("2026-10-16", 2, 500);
    await store.addAiUsage("2026-10-16", 1, 250);
    expect(await store.aiUsage("2026-10-16")).toBe(750);
    expect(await store.aiUsage("2026-10-17")).toBe(0);
  });

  it("esclude fonte, tag e concorsi con acquisto, come fa D1 in SQL", async () => {
    await store.insertItem(makeItem({ urlKey: "key-1", url: "https://a.example/1", sourceId: "vincimi", tags: ["giftcard"], requiresPurchase: false }));
    await store.insertItem(
      makeItem({ urlKey: "key-2", url: "https://b.example/2", title: "Raccolta bollini Bennet", sourceId: "sitemap-conad", tags: ["raccolta_punti", "brand"], requiresPurchase: true }),
    );
    await store.insertItem(
      makeItem({ urlKey: "key-3", url: "https://c.example/3", title: "Concorso con moda", sourceId: "premieconcorsi", tags: ["moda"], requiresPurchase: false }),
    );

    expect(await store.countItems({})).toBe(3);
    expect(await store.countItems({ excludeSources: ["vincimi"] })).toBe(2);
    expect(await store.countItems({ excludeTags: ["raccolta_punti"] })).toBe(2);
    expect(await store.countItems({ withoutPurchase: true })).toBe(2);
    // 💸 Con acquisto: la metà opposta, lo stesso confronto in memoria.
    expect(await store.countItems({ withPurchase: true })).toBe(1);
    expect(await store.countItems({ withPurchase: true, withoutPurchase: true })).toBe(0);
    expect((await store.queryItems({ excludeTags: ["raccolta_punti"], limit: 10 })).map((row) => row.sourceId)).toEqual([
      "premieconcorsi",
      "vincimi",
    ]);

    // Un tag non è un prefisso: "moda" non esclude "moda_bambini".
    await store.insertItem(
      makeItem({ urlKey: "key-4", url: "https://d.example/4", title: "Concorso bambini moda", sourceId: "vincimi", tags: ["moda_bambini"], requiresPurchase: false }),
    );
    expect(await store.countItems({ excludeTags: ["moda"] })).toBe(3);

    // L'inclusione per tag, che è il contrario: le porte di 🎁 Tipi di premio
    // chiedono "che premio cerchi?", e lì il tag acceso è quello da vedere.
    expect(await store.countItems({ tags: ["giftcard"] })).toBe(1);
    // Più tag = "almeno uno", come le esclusioni: nessuno ha due tag fra questi.
    expect(await store.countItems({ tags: ["giftcard", "moda_bambini"] })).toBe(2);
    expect(await store.countItems({ tags: [] })).toBe(4);
    expect(await store.countItems({ tags: ["inesistente"] })).toBe(0);

    // I tre filtri insieme, come li manda una chat che li ha accesi.
    const filtri = { ...defaultFilters(), mutedSources: ["sitemap-conad"], mutedTags: ["moda"], freeOnly: true };
    expect(await store.countItems(filtersFor(filtri, {}))).toBe(2);
    expect((await store.queryItems(filtersFor(filtri, { limit: 10 }))).map((row) => row.sourceId)).toEqual([
      "vincimi",
      "vincimi",
    ]);
  });

  it("la marca si salva, si filtra e si conta", async () => {
    await store.insertItem(makeItem({ urlKey: "key-1", url: "https://a.example/1", brand: "ferrero" }));
    await store.insertItem(makeItem({ urlKey: "key-2", url: "https://b.example/2", brand: "conad" }));
    await store.insertItem(makeItem({ urlKey: "key-3", url: "https://c.example/3", brand: "ferrero", kind: "news" }));
    // Un concorso senza marca riconosciuta: non è di nessuno, e non sparisce.
    await store.insertItem(makeItem({ urlKey: "key-4", url: "https://d.example/4", brand: null }));

    expect((await store.getItem(1))?.brand).toBe("ferrero");
    expect((await store.getItem(4))?.brand).toBeNull();
    expect(await store.countItems({ brands: ["ferrero"] })).toBe(2);
    expect((await store.queryItems({ brands: ["conad"], limit: 10 })).map((row) => row.id)).toEqual([2]);
    // Elenco vuoto = nessun filtro, come tutti gli altri campi della query.
    expect(await store.countItems({ brands: [] })).toBe(4);
    // 🔕 Marche spente: si toglie la marca, non l'archivio — e l'item senza
    // marca resta, perché non si può escludere quello che non si conosce.
    expect(await store.countItems({ excludeBrands: ["ferrero"] })).toBe(2);
    expect((await store.queryItems({ excludeBrands: ["ferrero", "conad"], limit: 10 })).map((row) => row.id)).toEqual([
      4,
    ]);
    expect(await store.countItems({ excludeBrands: [] })).toBe(4);
    // Il conteggio per marca conta solo i concorsi: l'articolo non gonfia il numero
    // che la chat scrive sul bottone.
    expect(await store.brandCounts()).toEqual({ ferrero: 1, conad: 1 });

    // La marca si aggiorna quando si riconosce, e un null non cancella quella che c'è.
    await store.updateItem(2, { brand: "esselunga" });
    expect((await store.getItem(2))?.brand).toBe("esselunga");
    await store.updateItem(2, { brand: null });
    expect((await store.getItem(2))?.brand).toBe("esselunga");
  });

  it("racconta quanto ha reso ogni fonte: concorsi, ultimo, viste e scartate", async () => {
    await store.insertItem(
      makeItem({ urlKey: "key-1", url: "https://a.example/1", sourceId: "vincimi", firstSeenAt: "2026-10-10T08:00:00.000Z" }),
    );
    await store.insertItem(
      makeItem({ urlKey: "key-2", url: "https://b.example/2", sourceId: "vincimi", firstSeenAt: "2026-10-16T08:00:00.000Z" }),
    );
    // Un articolo non è un concorso: non entra nel contributo della fonte.
    await store.insertItem(
      makeItem({ urlKey: "key-3", url: "https://c.example/3", sourceId: "news-brand", kind: "news" }),
    );
    // Viste: una ripetuta, una scartata dal cancello di freschezza.
    await store.recordSighting({
      urlKey: "key-1", sourceId: "sitemap-conad", itemId: 1, kind: "contest", channel: "brand",
      seenAt: "2026-10-16T09:00:00.000Z", kept: true,
    });
    await store.recordSighting({
      urlKey: "key-9", sourceId: "sitemap-conad", itemId: null, kind: "contest", channel: "brand",
      seenAt: "2026-10-16T09:00:00.000Z", kept: false,
    });

    const stats = await store.sourceStats();
    expect(stats.vincimi).toEqual({
      offers: 2, lastOfferAt: "2026-10-16T08:00:00.000Z", sightings: 0, discarded: 0,
    });
    // Conad: due viste, nessun concorso portato per prima, una pagina scartata.
    expect(stats["sitemap-conad"]).toEqual({
      offers: 0, lastOfferAt: null, sightings: 2, discarded: 1,
    });
    // Una fonte mai vista non compare: chi legge usa SourceStat vuoto.
    expect(stats["sitemap-ferrero"]).toBeUndefined();
  });

  it("un coupon è un contributo: la fonte di buoni sconto non risulta vuota", async () => {
    // Senza questo, la diagnostica direbbe "non ha mai portato un concorso" di una
    // fonte che pubblica buoni sconto — cioè che non fa il suo lavoro, mentre lo
    // sta facendo (vedi SourceStat e src/sources-health.ts).
    await store.insertItem(
      makeItem({
        urlKey: "key-1",
        url: "https://a.example/1",
        sourceId: "scontrinofelice-coupon",
        kind: "coupon",
        firstSeenAt: "2026-10-16T09:30:00.000Z",
      }),
    );

    const stats = await store.sourceStats();
    expect(stats["scontrinofelice-coupon"]).toEqual({
      offers: 1, lastOfferAt: "2026-10-16T09:30:00.000Z", sightings: 0, discarded: 0,
    });
  });

  it("salva e ricarica robots.txt per origine", async () => {
    expect(await store.getRobots("https://www.premieconcorsi.com")).toBeNull();
    await store.saveRobots("https://www.premieconcorsi.com", "User-agent: *\nDisallow: /admin", "2026-10-16T08:00:00.000Z");
    const robots = await store.getRobots("https://www.premieconcorsi.com");
    expect(robots?.body).toContain("Disallow: /admin");
    expect(robots?.fetchedAt).toBe("2026-10-16T08:00:00.000Z");

    await store.saveRobots("https://www.premieconcorsi.com", "User-agent: *\nDisallow:", "2026-10-16T09:00:00.000Z");
    expect((await store.getRobots("https://www.premieconcorsi.com"))?.fetchedAt).toBe("2026-10-16T09:00:00.000Z");
  });
});
