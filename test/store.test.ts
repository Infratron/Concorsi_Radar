import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../src/db/memory.ts";
import { DUP_CANDIDATE_MAX_HAMMING, hammingHex, simhash } from "../src/lib/text.ts";
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
    });
    const prefs = await store.getPrefs(999);
    expect(prefs?.minScoreInstant).toBe(75);
    expect(prefs?.weights).toEqual({ giftcard: 2 });
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

  it("recordSourceRun incrementa e azzera fail_streak", async () => {
    await store.recordSourceRun("scontrinofelice-acquisto", {
      ok: false, httpStatus: 500, etag: null, lastModified: null, error: "HTTP 500", now: "2026-10-16T08:00:00.000Z",
    });
    let source = (await store.getSources()).find((s) => s.id === "scontrinofelice-acquisto");
    expect(source?.failStreak).toBe(1);
    expect(source?.lastOkAt).toBeNull();

    await store.recordSourceRun("scontrinofelice-acquisto", {
      ok: false, httpStatus: 500, etag: null, lastModified: null, error: "HTTP 500", now: "2026-10-16T08:15:00.000Z",
    });
    source = (await store.getSources()).find((s) => s.id === "scontrinofelice-acquisto");
    expect(source?.failStreak).toBe(2);

    await store.recordSourceRun("scontrinofelice-acquisto", {
      ok: true, httpStatus: 200, etag: "W/abc", lastModified: "Thu, 16 Oct 2026 08:00:00 GMT", error: null, now: "2026-10-16T08:30:00.000Z",
    });
    source = (await store.getSources()).find((s) => s.id === "scontrinofelice-acquisto");
    expect(source?.failStreak).toBe(0);
    expect(source?.lastOkAt).toBe("2026-10-16T08:30:00.000Z");
    expect(source?.etag).toBe("W/abc");
    expect(source?.lastModified).toBe("Thu, 16 Oct 2026 08:00:00 GMT");

    // Un id sconosciuto non deve esplodere.
    await store.recordSourceRun("assente", {
      ok: true, httpStatus: 200, etag: null, lastModified: null, error: null, now: "2026-10-16T08:30:00.000Z",
    });
    expect(await store.getSources()).toHaveLength(2);
  });

  it("claimUpdate accetta un update_id una volta sola", async () => {
    expect(await store.claimUpdate(101, "2026-10-16T08:00:00.000Z")).toBe(true);
    expect(await store.claimUpdate(101, "2026-10-16T08:00:01.000Z")).toBe(false);
    expect(await store.claimUpdate(102, "2026-10-16T08:00:02.000Z")).toBe(true);
  });

  it("recordRun e recentRuns restituiscono i run più recenti per primi", async () => {
    await store.recordRun({ startedAt: "2026-10-16T08:00:00.000Z", trigger: "*/15 * * * *", sourcesOk: 2, sourcesFail: 0, itemsNew: 4, ms: 120, note: null });
    await store.recordRun({ startedAt: "2026-10-16T09:00:00.000Z", trigger: "*/15 * * * *", sourcesOk: 1, sourcesFail: 1, itemsNew: 2, ms: 200, note: "soldissimi: HTTP 429" });
    const runs = await store.recentRuns(5);
    expect(runs).toHaveLength(2);
    expect(runs[0].startedAt).toBe("2026-10-16T09:00:00.000Z");
    expect(runs[0].note).toBe("soldissimi: HTTP 429");
  });

  it("somma il consumo Workers AI del giorno", async () => {
    expect(await store.aiUsage("2026-10-16")).toBe(0);
    await store.addAiUsage("2026-10-16", 2, 500);
    await store.addAiUsage("2026-10-16", 1, 250);
    expect(await store.aiUsage("2026-10-16")).toBe(750);
    expect(await store.aiUsage("2026-10-17")).toBe(0);
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
