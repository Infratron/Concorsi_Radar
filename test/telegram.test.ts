import { describe, expect, it } from "vitest";
import type { Store } from "../src/db/store.ts";
import type { FetchLike, ItemRow, Prefs, RunRow, SourceRow } from "../src/types.ts";
import { TelegramClient, MAX_MESSAGE_CHARS, type TelegramUpdate } from "../src/telegram/api.ts";
import {
  daysLeft,
  escapeHtml,
  formatDate,
  formatDigest,
  formatItemCard,
  formatItemLine,
  localDateString,
  localHour,
} from "../src/telegram/format.ts";
import { itemKeyboard, itemKeyboardWithRegolamento } from "../src/telegram/keyboard.ts";
import { handleUpdate } from "../src/telegram/bot.ts";
import { isQuietHour, regolamentoUrl } from "../src/telegram/digest.ts";

/** Stub inline: il memory store vero lo scrive un altro worker. */
function makeStore() {
  const prefs = new Map<number, Prefs>();
  const items = new Map<number, ItemRow>();
  const statuses = new Map<number, string>();
  const updates = new Set<number>();
  const deliveries: { chatId: number; itemId: number; kind: string }[] = [];
  const sources: SourceRow[] = [];
  const runs: RunRow[] = [];

  const store: Store = {
    async getSources() {
      return sources;
    },
    async recordSourceRun() {},
    async findDuplicateCandidates() {
      return [];
    },
    async insertItem(item) {
      const row = { ...item, id: items.size + 1 } as ItemRow;
      items.set(row.id, row);
      return { item: row, created: true };
    },
    async updateItem() {},
    async getItem(id) {
      return items.get(id) ?? null;
    },
    async queryItems() {
      return [...items.values()];
    },
    async setStatus(id, status) {
      statuses.set(id, status);
    },
    async touchItem() {},
    async getPrefs(chatId) {
      return prefs.get(chatId) ?? null;
    },
    async upsertPrefs(value) {
      prefs.set(value.chatId, value);
    },
    async listChats() {
      return [...prefs.keys()];
    },
    async isDelivered(chatId, itemId, kind) {
      return deliveries.some((d) => d.chatId === chatId && d.itemId === itemId && d.kind === kind);
    },
    async recordDelivery(chatId, itemId, kind) {
      deliveries.push({ chatId, itemId, kind });
    },
    async lastDeliveryAt() {
      return null;
    },
    async bumpWeights() {},
    async recordRun(run) {
      runs.push(run);
    },
    async recentRuns() {
      return [];
    },
    async claimUpdate(updateId) {
      if (updates.has(updateId)) return false;
      updates.add(updateId);
      return true;
    },
    async aiUsage() {
      return 0;
    },
    async addAiUsage() {},
    async getRobots() {
      return null;
    },
    async saveRobots() {},
  };

  return { store, prefs, items, statuses, deliveries };
}

function makeTg() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = String(input);
    const method = url.split("/").pop() ?? "";
    calls.push({ method, payload: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
  };
  return { tg: new TelegramClient("test-token", fetcher), calls };
}

function makeItem(partial: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 1,
    sourceId: "premieconcorsi",
    url: "https://esempio.it/concorso/1",
    urlKey: "abc",
    simhash: "0123456789abcdef",
    title: "Concorso esempio",
    summary: "Vinci buoni spesa",
    publishedAt: null,
    firstSeenAt: "2026-11-19T10:00:00.000Z",
    lastSeenAt: "2026-11-19T10:00:00.000Z",
    deadline: "2026-11-30",
    prize: "Buoni spesa da 100 €",
    participation: "Senza obbligo di acquisto",
    prizeValue: 0.8,
    effort: 0.9,
    requiresPurchase: false,
    tags: ["giftcard"],
    score: 85,
    clusterId: null,
    status: "new",
    aiUsed: false,
    ...partial,
  };
}

describe("format", () => {
  it("esegue l'escape di &, < e >", () => {
    expect(escapeHtml('<b>&"</b>')).toBe("&lt;b&gt;&amp;&quot;&lt;/b&gt;");
  });

  it("non lascia passare HTML dai titoli delle fonti", () => {
    const card = formatItemCard(
      makeItem({ title: 'Concorso <script>alert("x")</script> & premi' }),
      new Date("2026-11-20T10:00:00Z"),
    );
    expect(card).toContain("&lt;script&gt;");
    expect(card).not.toContain("<script>");
    expect(card).toContain("&amp;");
  });

  it("mostra i giorni mancanti solo quando sono utili", () => {
    const item = makeItem({ deadline: "2026-11-24" });
    expect(formatItemLine(item, new Date("2026-11-20T10:00:00Z"))).toContain("⏳4gg");
    const lontano = makeItem({ deadline: "2027-05-01" });
    expect(formatItemLine(lontano, new Date("2026-11-20T10:00:00Z"))).not.toContain("⏳");
  });

  it("calcola giorni e date locali italiane", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    expect(daysLeft("2026-11-30", now)).toBe(10);
    expect(daysLeft("2026-11-19", now)).toBe(-1);
    expect(daysLeft(null, now)).toBeNull();
    expect(formatDate("2026-11-30")).toBe("30/11/2026");
    expect(formatDate(null)).toBe("—");
    // 23:30 UTC è già il giorno dopo a Roma
    expect(localDateString(new Date("2026-11-20T23:30:00Z"))).toBe("2026-11-21");
  });

  it("legge l'ora locale tenendo conto dell'ora legale", () => {
    expect(localHour(new Date("2026-07-01T10:00:00Z"))).toBe(12); // CEST
    expect(localHour(new Date("2026-01-15T10:00:00Z"))).toBe(11); // CET
  });

  it("spezza il digest restando sotto il limite Telegram", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    const items = Array.from({ length: 60 }, (_, index) =>
      makeItem({
        id: index + 1,
        title: `Concorso molto lungo numero ${index + 1} con premio importante in gift card e buoni spesa`,
        summary: "x".repeat(120),
      }),
    );
    const messages = formatDigest([{ title: "📋 Altri", items }], now);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    const links = messages.join("\n").match(/<a href="https:\/\/esempio\.it/g) ?? [];
    expect(links.length).toBe(60);
  });
});

describe("keyboard", () => {
  it("usa i callback_data attesi", () => {
    const keyboard = itemKeyboard(7, "https://esempio.it/x");
    expect(keyboard.inline_keyboard[0]?.[0]).toEqual({ text: "✅ Salva", callback_data: "save:7" });
    expect(keyboard.inline_keyboard[0]?.[1]).toEqual({ text: "🚫 Non mi interessa", callback_data: "ign:7" });
    expect(keyboard.inline_keyboard[0]?.[2]).toEqual({ text: "🏆 Vinto", callback_data: "won:7" });
    expect(keyboard.inline_keyboard[1]?.[0]).toEqual({ text: "🔗 Apri", url: "https://esempio.it/x" });
  });

  it("aggiunge il regolamento quando disponibile", () => {
    const keyboard = itemKeyboardWithRegolamento(9, "https://a.it/x", "https://a.it/regolamento.pdf");
    expect(keyboard.inline_keyboard[1]?.[1]).toEqual({ text: "📄 Regolamento", url: "https://a.it/regolamento.pdf" });
  });
});

describe("digest guards", () => {
  it("riconosce la fascia di silenzio", () => {
    const prefs: Prefs = {
      chatId: 1, active: true, weights: {}, minScoreInstant: 80, quietHours: "23-7", digestHours: [8, 19],
    };
    expect(isQuietHour(prefs, new Date("2026-11-20T23:30:00Z"))).toBe(true); // 00:30 a Roma
    expect(isQuietHour(prefs, new Date("2026-11-20T12:00:00Z"))).toBe(false); // 13:00 a Roma
  });

  it("trova l'URL del regolamento senza duplicare la pagina", () => {
    expect(regolamentoUrl(makeItem({ summary: "Vedi https://esempio.it/regolamento.pdf per i dettagli" }))).toBe(
      "https://esempio.it/regolamento.pdf",
    );
    expect(regolamentoUrl(makeItem({ url: "https://esempio.it/regolamento", summary: "" }))).toBeNull();
  });
});

describe("handleUpdate", () => {
  it("è idempotente sullo stesso update_id", async () => {
    const { store } = makeStore();
    const { tg } = makeTg();
    const update: TelegramUpdate = { update_id: 1, message: { message_id: 5, chat: { id: 42 }, text: "/start" } };
    const deps = { store, tg, now: new Date("2026-11-20T10:00:00Z"), adminChatId: 42 };

    expect((await handleUpdate(update, deps)).handled).toBe(true);
    expect((await handleUpdate(update, deps)).handled).toBe(false);
  });

  it("/start salva le preferenze di default", async () => {
    const { store, prefs } = makeStore();
    const { tg } = makeTg();
    await handleUpdate(
      { update_id: 2, message: { message_id: 6, chat: { id: 42 }, text: "/start" } },
      { store, tg, now: new Date("2026-11-20T10:00:00Z"), adminChatId: 42 },
    );
    const saved = prefs.get(42);
    expect(saved?.active).toBe(true);
    expect(saved?.minScoreInstant).toBe(80);
    expect(saved?.quietHours).toBe("23-7");
    expect(saved?.digestHours).toEqual([8, 19]);
  });

  it("gestisce il bottone ✅ Salva come decisione per chat", async () => {
    const { store, items, statuses, deliveries } = makeStore();
    const { tg, calls } = makeTg();
    items.set(7, makeItem({ id: 7 }));

    const result = await handleUpdate(
      {
        update_id: 3,
        callback_query: {
          id: "cb-1",
          data: "save:7",
          message: { message_id: 9, chat: { id: 42 } },
        },
      },
      { store, tg, now: new Date("2026-11-20T10:00:00Z"), adminChatId: 42 },
    );

    expect(result.handled).toBe(true);
    expect(deliveries).toContainEqual({ chatId: 42, itemId: 7, kind: "saved" });
    // Non deve diventare uno stato globale: l'altro utente lo riceve comunque.
    expect(statuses.has(7)).toBe(false);
    expect(calls.map((call) => call.method)).toContain("answerCallbackQuery");
  });

  it("ignora le chat non autorizzate", async () => {
    const { store } = makeStore();
    const { tg, calls } = makeTg();
    await handleUpdate(
      { update_id: 4, message: { message_id: 7, chat: { id: 999 }, text: "/oggi" } },
      { store, tg, now: new Date("2026-11-20T10:00:00Z"), adminChatId: 42 },
    );
    // Il rifiuto deve anche dire qual è il chat id, per poterlo autorizzare.
    expect(calls[0]?.payload.text).toContain("⛔ Bot privato");
    expect(calls[0]?.payload.text).toContain("999");
    expect(calls[0]?.payload.text).toContain("ALLOWED_CHAT_IDS");
  });
});
