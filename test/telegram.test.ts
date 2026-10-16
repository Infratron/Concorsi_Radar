import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../src/db/memory.ts";
import type { FetchLike, ItemRow, NewItem, Prefs } from "../src/types.ts";
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
import { cardKeyboard, listKeyboard, menuKeyboard, settingsKeyboard } from "../src/telegram/keyboard.ts";
import { applyIntent, parseCallback } from "../src/telegram/screens.ts";
import { handleUpdate } from "../src/telegram/bot.ts";
import { isQuietHour, regolamentoUrl, sendDigests } from "../src/telegram/digest.ts";

/**
 * Test dell'interfaccia: menù a pulsanti su UN solo messaggio.
 * Niente rete: il client Telegram è vero, con un finto fetch che registra le
 * chiamate, e il database è lo store in-memory (stessa semantica di D1).
 *
 * La verifica che conta: navigando, il bot deve *modificare* il messaggio che ha
 * già mandato, non accumularne di nuovi, e deve cancellare il comando scritto
 * dall'utente.
 */

/** 20/11/2026 11:00 a Roma. */
const NOW = new Date("2026-11-20T10:00:00.000Z");
const CHAT = 4242;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/**
 * Finto Telegram: registra ogni chiamata e si comporta come l'API vera sul punto
 * che conta, cioè rifiuta una modifica che non cambia nulla ("message is not
 * modified"), che è quello che succede al doppio tocco sullo stesso bottone.
 */
function makeTg() {
  const calls: Call[] = [];
  const testi = new Map<number, string>();
  let nextMessageId = 100;

  const fetcher: FetchLike = async (input, init) => {
    const method = String(input).split("/").pop() ?? "";
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, payload });

    if (method === "sendMessage") {
      const id = nextMessageId++;
      testi.set(id, String(payload.text));
      return jsonResponse({ ok: true, result: { message_id: id } });
    }
    if (method === "editMessageText") {
      const id = Number(payload.message_id);
      // Come l'API vera: un messaggio che non esiste più non si può modificare.
      if (!testi.has(id)) return jsonResponse({ ok: false, description: "Bad Request: message to edit not found" }, 400);
      if (testi.get(id) === String(payload.text)) {
        return jsonResponse({ ok: false, description: "Bad Request: message is not modified" }, 400);
      }
      testi.set(id, String(payload.text));
      return jsonResponse({ ok: true, result: { message_id: id } });
    }
    return jsonResponse({ ok: true, result: true });
  };

  return { tg: new TelegramClient("test-token", fetcher), calls };
}

function makeItem(partial: Partial<NewItem> = {}): NewItem {
  return {
    sourceId: "premieconcorsi",
    url: "https://esempio.it/concorso/1",
    urlKey: "key-1",
    simhash: "0123456789abcdef",
    title: "Concorso esempio con gift card",
    summary: "Vinci buoni spesa da 100 euro",
    publishedAt: null,
    firstSeenAt: "2026-11-20T08:00:00.000Z",
    lastSeenAt: "2026-11-20T08:00:00.000Z",
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

let seedCounter = 0;

async function seed(store: MemoryStore, items: Partial<NewItem>[]): Promise<number[]> {
  const ids: number[] = [];
  for (const [index, partial] of items.entries()) {
    // Chiave sempre nuova: due chiamate a seed() non devono collidere su urlKey,
    // altrimenti il secondo item non verrebbe inserito.
    const unique = ++seedCounter;
    const inserted = await store.insertItem(
      makeItem({
        url: `https://esempio.it/concorso/${unique}`,
        urlKey: `key-${unique}`,
        title: `Concorso numero ${index + 1}`,
        ...partial,
      }),
    );
    ids.push(inserted.item.id);
  }
  return ids;
}

/** Riga completa (con id) per i test di formattazione e delle tastiere. */
function row(partial: Partial<ItemRow> = {}): ItemRow {
  return { ...makeItem(), id: 1, ...partial } as ItemRow;
}

function prefs(partial: Partial<Prefs> = {}): Prefs {
  return {
    chatId: CHAT,
    active: true,
    weights: {},
    minScoreInstant: 80,
    quietHours: "23-7",
    digestHours: [8, 19],
    ...partial,
  };
}

function deps(store: MemoryStore, tg: TelegramClient, adminChatId = CHAT) {
  return { store, tg, now: NOW, adminChatId, allowedChatIds: [CHAT] };
}

function command(updateId: number, text: string): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: CHAT }, text, from: { id: CHAT } } };
}

function tap(updateId: number, data: string, messageId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data, message: { message_id: messageId, chat: { id: CHAT } }, from: { id: CHAT } },
  };
}

const methods = (calls: Call[]): string[] => calls.map((call) => call.method);
const lastWith = (calls: Call[], method: string): Call | undefined =>
  [...calls].reverse().find((call) => call.method === method);

describe("format", () => {
  it("esegue l'escape di &, < e >", () => {
    expect(escapeHtml('<b>&"</b>')).toBe("&lt;b&gt;&amp;&quot;&lt;/b&gt;");
  });

  it("non lascia passare HTML dai titoli delle fonti", () => {
    const card = formatItemCard(row({ title: 'Concorso <script>alert("x")</script> & premi' }), NOW);
    expect(card).toContain("&lt;script&gt;");
    expect(card).not.toContain("<script>");
    expect(card).toContain("&amp;");
  });

  it("mostra i giorni mancanti solo quando sono utili", () => {
    expect(formatItemLine(row({ deadline: "2026-11-24" }), NOW)).toContain("⏳4gg");
    expect(formatItemLine(row({ id: 2, deadline: "2027-05-01" }), NOW)).not.toContain("⏳");
  });

  it("calcola giorni e date locali italiane", () => {
    expect(daysLeft("2026-11-30", NOW)).toBe(10);
    expect(daysLeft("2026-11-19", NOW)).toBe(-1);
    expect(daysLeft(null, NOW)).toBeNull();
    expect(formatDate("2026-11-30")).toBe("30/11/2026");
    expect(formatDate(null)).toBe("—");
    expect(localDateString(new Date("2026-11-20T23:30:00Z"))).toBe("2026-11-21");
  });

  it("legge l'ora locale tenendo conto dell'ora legale", () => {
    expect(localHour(new Date("2026-07-01T10:00:00Z"))).toBe(12); // CEST
    expect(localHour(new Date("2026-01-15T10:00:00Z"))).toBe(11); // CET
  });

  it("spezza il digest restando sotto il limite Telegram", () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      row({
        id: index + 1,
        title: `Concorso molto lungo numero ${index + 1} con premio importante in gift card e buoni spesa`,
        summary: "x".repeat(120),
      }),
    );
    const messages = formatDigest([{ title: "📋 Altri", items }], NOW);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect((messages.join("\n").match(/<a href="https:\/\/esempio\.it/g) ?? []).length).toBe(60);
  });
});

describe("bottoni · costruzione delle tastiere", () => {
  it("il menù porta a tutte le sezioni, con i conteggi", () => {
    const keyboard = menuKeyboard({ nuovi: 3, oggi: 12, settimana: 40, scadenze: 2, salvati: 1 });
    const bottoni = keyboard.inline_keyboard.flat();
    expect(bottoni.map((b) => b.callback_data)).toEqual([
      "s:nuovi", "s:oggi", "s:settimana", "s:scadenze", "s:salvati", "s:cerca", "s:fonti", "s:impostazioni", "refresh",
    ]);
    expect(bottoni[0]?.text).toBe("🆕 Nuovi (3)");
  });

  it("l'elenco ha un bottone per concorso e i numeri di pagina solo se servono", () => {
    const items = Array.from({ length: 3 }, (_, index) => row({ id: index + 1 }));
    const unaPagina = listKeyboard(items, NOW, { index: 0, total: 1 });
    expect(unaPagina.inline_keyboard).toHaveLength(4); // 3 item + riga di navigazione
    expect(unaPagina.inline_keyboard[0]?.[0]?.callback_data).toBe("open:1");

    const due = listKeyboard(items, NOW, { index: 0, total: 2 });
    expect(due.inline_keyboard[3]?.map((b) => b.callback_data)).toEqual(["noop", "noop", "page:1"]);
    const seconda = listKeyboard(items, NOW, { index: 1, total: 2 });
    expect(seconda.inline_keyboard[3]?.map((b) => b.callback_data)).toEqual(["page:0", "noop", "noop"]);
  });

  it("nella scheda il bottone della decisione già presa è inerte", () => {
    const item = row({ id: 7 });
    const keyboard = cardKeyboard(item, "saved", "https://esempio.it/regolamento");
    const prima = keyboard.inline_keyboard[0] ?? [];
    expect(prima[0]).toEqual({ text: "✅ Salvato", callback_data: "noop" });
    expect(prima[1]?.callback_data).toBe("ign:7");
    expect(keyboard.inline_keyboard[1]?.map((b) => b.text)).toEqual(["🔗 Apri", "📄 Regolamento"]);
    expect(keyboard.inline_keyboard[2]?.map((b) => b.callback_data)).toEqual(["back", "refresh", "home"]);
  });

  it("le impostazioni marcano i valori attivi", () => {
    const keyboard = settingsKeyboard(prefs({ minScoreInstant: 90, quietHours: "22-8", digestHours: [] }));
    const righe = keyboard.inline_keyboard;
    expect(righe[0]?.find((b) => b.text.startsWith("•"))?.text).toBe("• 90");
    expect(righe[1]?.find((b) => b.text.startsWith("•"))?.text).toBe("• 22–8");
    expect(righe[2]?.find((b) => b.text.startsWith("•"))?.text).toBe("• Off");
    expect(righe[3]?.[0]?.callback_data).toBe("cfg:notify:off");
  });
});

describe("intenti", () => {
  it("traduce i callback_data dei bottoni", () => {
    expect(parseCallback("s:oggi")).toEqual({ kind: "section", section: "oggi" });
    expect(parseCallback("open:17")).toEqual({ kind: "open", itemId: 17 });
    expect(parseCallback("save:5")).toEqual({ kind: "decision", action: "save", itemId: 5 });
    expect(parseCallback("won:5")).toEqual({ kind: "decision", action: "won", itemId: 5 });
    expect(parseCallback("cfg:digest:7,13,20")).toEqual({ kind: "config", key: "digest", value: "7,13,20" });
    expect(parseCallback("home")).toEqual({ kind: "home" });
    expect(parseCallback("back")).toEqual({ kind: "back" });
  });

  it("ignora quello che non conosce", () => {
    expect(parseCallback("noop")).toEqual({ kind: "none" });
    expect(parseCallback("s:inesistente")).toEqual({ kind: "none" });
    expect(parseCallback("cfg:boh:1")).toEqual({ kind: "none" });
    expect(parseCallback(undefined)).toEqual({ kind: "none" });
  });

  it("aprire una sezione azzera pagina e scheda, indietro chiude solo la scheda", () => {
    const stato = { chatId: 1, messageId: 10, section: "oggi", page: 3, openItemId: 9, lastCheckAt: null };
    const sezione = applyIntent(stato, { kind: "section", section: "scadenze" }, NOW);
    expect(sezione).toMatchObject({ section: "scadenze", page: 0, openItemId: null });
    const scheda = applyIntent(sezione, { kind: "open", itemId: 4 }, NOW);
    expect(scheda).toMatchObject({ section: "scadenze", openItemId: 4 });
    const indietro = applyIntent(scheda, { kind: "back" }, NOW);
    expect(indietro).toMatchObject({ section: "scadenze", openItemId: null });
    // Il "controllo" non si sposta qui: lo fa bot.ts solo quando i nuovi si vedono.
    expect(indietro.lastCheckAt).toBeNull();
  });
});

describe("interfaccia · un solo messaggio per chat", () => {
  let store: MemoryStore;
  let ids: number[];

  beforeEach(async () => {
    store = createMemoryStore();
    await store.upsertPrefs(prefs());
    ids = await seed(store, [
      { title: "Barilla vinci una Fiat Panda" },
      { title: "Findus buoni spesa" },
      { title: "Nutella vinci un viaggio", firstSeenAt: "2026-11-15T08:00:00.000Z" },
      { title: "Sammontana gusta e vinci", firstSeenAt: "2026-11-10T08:00:00.000Z" },
    ]);
  });

  it("/start cancella il comando e manda il menù, salvando l'id del messaggio", async () => {
    const { tg, calls } = makeTg();
    const result = await handleUpdate(command(1, "/start"), deps(store, tg));

    expect(result.handled).toBe(true);
    expect(methods(calls)).toContain("deleteMessage");
    expect(lastWith(calls, "deleteMessage")?.payload.message_id).toBe(1);

    const inviato = lastWith(calls, "sendMessage");
    expect(inviato?.payload.text).toContain("Concorsi Radar");
    const keyboard = inviato?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] };
    expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toContain("s:oggi");

    const stato = await store.getUiState(CHAT);
    expect(stato?.messageId).toBe(100);
    expect(stato?.section).toBe("menu");
  });

  it("toccare una sezione modifica il messaggio esistente invece di mandarne uno nuovo", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;

    await handleUpdate(tap(2, "s:oggi", 100), deps(store, tg));

    expect(methods(calls)).not.toContain("sendMessage");
    const modifica = lastWith(calls, "editMessageText");
    expect(modifica?.payload.message_id).toBe(100);
    expect(modifica?.payload.text).toContain("Ultime 24 ore");
    expect(methods(calls)).toContain("answerCallbackQuery");
  });

  it("aprire un concorso mostra la scheda e \"torna\" riporta all'elenco", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "open:1", 100), deps(store, tg));

    let stato = await store.getUiState(CHAT);
    expect(stato?.openItemId).toBe(1);
    const scheda = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(scheda).toContain("Barilla vinci una Fiat Panda");
    expect(scheda).toContain("🆔 <code>1</code>");

    await handleUpdate(tap(3, "back", 100), deps(store, tg));
    stato = await store.getUiState(CHAT);
    expect(stato?.openItemId).toBeNull();
  });

  it("la decisione nella scheda resta visibile e addestra i pesi di quella chat", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "open:1", 100), deps(store, tg));
    await handleUpdate(tap(3, "save:1", 100), deps(store, tg));

    expect(await store.isDelivered(CHAT, 1, "saved")).toBe(true);
    expect((await store.getPrefs(CHAT))?.weights.giftcard).toBe(1);

    const toast = lastWith(calls, "answerCallbackQuery")?.payload.text;
    expect(toast).toBe("✅ Salvato");
    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("✅ <b>Salvato da te</b>");
  });

  it("una decisione presa dall'avviso toglie l'avviso e aggiorna la schermata", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;

    // Notifica (messaggio 777) diversa dalla schermata viva (100): si usa e si toglie.
    const notifica: TelegramUpdate = {
      update_id: 2,
      callback_query: { id: "cb-2", data: "save:2", message: { message_id: 777, chat: { id: CHAT } }, from: { id: CHAT } },
    };
    await handleUpdate(notifica, deps(store, tg));

    expect(await store.isDelivered(CHAT, 2, "saved")).toBe(true);
    const cancellati = calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload.message_id);
    expect(cancellati).toContain(777);
    expect(lastWith(calls, "editMessageText")?.payload.message_id).toBe(100);
    expect(methods(calls)).not.toContain("sendMessage");
  });

  it("il doppio tocco sullo stesso bottone non duplica il messaggio", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:settimana", 100), deps(store, tg));
    calls.length = 0;

    // Secondo tocco identico: l'API risponde "message is not modified".
    await handleUpdate(tap(3, "s:settimana", 100), deps(store, tg));
    expect(methods(calls)).not.toContain("sendMessage");
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1);
  });

  it("se il messaggio è stato cancellato a mano, ne parte uno nuovo", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await store.saveUiState({ ...(await store.getUiState(CHAT))!, messageId: 99999 });
    calls.length = 0;

    await handleUpdate(tap(2, "s:oggi", 99999), deps(store, tg));
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Ultime 24 ore");
    expect((await store.getUiState(CHAT))?.messageId).not.toBe(99999);
  });

  it("dallo stato senza messaggio il menù viene inviato una volta sola", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    calls.length = 0;
    await handleUpdate(tap(2, "refresh", 100), deps(store, tg));
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });

  it("impagina gli elenchi lunghi", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(
      store2,
      Array.from({ length: 8 }, (_, index) => ({ title: `Concorso lungo numero ${index + 1}` })),
    );
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    await handleUpdate(tap(2, "s:oggi", 100), deps(store2, tg));

    const prima = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(prima).toContain("8 concorsi");
    expect(prima).toContain("pagina 1/2");

    await handleUpdate(tap(3, "page:1", 100), deps(store2, tg));
    const seconda = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(seconda).toContain("pagina 2/2");
    const keyboard = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    };
    expect(keyboard.inline_keyboard[0]?.[0]?.text).toContain("Concorso lungo numero 7");
  });

  it("una pagina fuori intervallo torna dentro e mostra contenuto", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:oggi", 100), deps(store, tg));
    await handleUpdate(tap(3, "page:9", 100), deps(store, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("concorsi");
    expect(testo).not.toContain("Nessun concorso");
    expect((await store.getUiState(CHAT))?.page).toBe(0);
  });

  it("le impostazioni cambiano preferenze reali e si rileggono subito", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:impostazioni", 100), deps(store, tg));
    await handleUpdate(tap(3, "cfg:score:90", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.minScoreInstant).toBe(90);
    expect(lastWith(calls, "answerCallbackQuery")?.payload.text).toBe("🔔 Avvisi sopra 90/100");

    await handleUpdate(tap(4, "cfg:quiet:off", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.quietHours).toBe("");

    await handleUpdate(tap(5, "cfg:digest:7,13,20", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.digestHours).toEqual([7, 13, 20]);

    await handleUpdate(tap(6, "cfg:digest:off", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.digestHours).toEqual([]);

    await handleUpdate(tap(7, "cfg:notify:off", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.active).toBe(false);
    expect(lastWith(calls, "answerCallbackQuery")?.payload.text).toBe("⏸ Notifiche sospese");

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("📣 Notifiche: <b>sospese</b>");
  });

  it("valori inventati dalle impostazioni non cambiano nulla", async () => {
    const { tg } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "cfg:score:999", 100), deps(store, tg));
    await handleUpdate(tap(3, "cfg:quiet:99-99", 100), deps(store, tg));
    await handleUpdate(tap(4, "cfg:quiet:7-33", 100), deps(store, tg));
    await handleUpdate(tap(5, "cfg:digest:99", 100), deps(store, tg));
    const salvate = await store.getPrefs(CHAT);
    expect(salvate?.minScoreInstant).toBe(80);
    expect(salvate?.quietHours).toBe("23-7");
    expect(salvate?.digestHours).toEqual([8, 19]);
  });

  it("la ricerca parte dal pulsante e usa il messaggio successivo come parola", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:cerca", 100), deps(store, tg));
    expect(lastWith(calls, "editMessageText")?.payload.text).toContain("Scrivi la parola da cercare");
    expect((await store.getUiState(CHAT))?.section).toBe("cerca");

    await handleUpdate(command(3, "viaggio"), deps(store, tg));
    expect((await store.getUiState(CHAT))?.section).toBe("cerca:viaggio");
    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("Ricerca: viaggio");
    expect(methods(calls)).toContain("deleteMessage");
  });

  it("fuori dalla ricerca un testo libero riapre il menù senza creare messaggi", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;
    await handleUpdate(command(2, "ciao"), deps(store, tg));
    expect(methods(calls)).toEqual(["deleteMessage", "editMessageText"]);
    expect(lastWith(calls, "editMessageText")?.payload.text).toContain("Concorsi Radar");
  });

  it("il contatore dei nuovi riparte dopo aver visto la sezione", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [{ title: "Concorso vecchio", firstSeenAt: "2026-11-10T08:00:00.000Z" }]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));

    // Arriva un concorso nuovo mentre l'utente non guarda.
    await seed(store2, [{ title: "Concorso appena arrivato", firstSeenAt: "2026-11-20T09:30:00.000Z" }]);
    await handleUpdate(tap(2, "refresh", 100), deps(store2, tg));
    const menu = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(menu.inline_keyboard.flat().find((b) => b.callback_data === "s:nuovi")?.text).toBe("🆕 Nuovi (1)");

    await handleUpdate(tap(3, "s:nuovi", 100), deps(store2, tg));
    const elenco = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(elenco).toContain("Nuovi dall'ultimo controllo");
    expect(elenco).toContain("1 concorso");
    const righeElenco = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    }).inline_keyboard;
    expect(righeElenco[0]?.[0]?.text).toContain("Concorso appena arrivato");
    expect((await store2.getUiState(CHAT))?.lastCheckAt).toBe(NOW.toISOString());

    await handleUpdate(tap(4, "home", 100), deps(store2, tg));
    const menuDopo = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(menuDopo.inline_keyboard.flat().find((b) => b.callback_data === "s:nuovi")?.text).toBe("🆕 Nuovi (0)");
  });

  it("la sezione scadenze mostra solo chi deve ancora chiudere", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [
      { title: "Scade domani", deadline: "2026-11-21" },
      { title: "Già chiuso", deadline: "2026-11-01" },
      { title: "Scade tra un mese", deadline: "2026-12-20" },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    await handleUpdate(tap(2, "s:scadenze", 100), deps(store2, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("1 concorso");
    const keyboard = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    };
    expect(keyboard.inline_keyboard[0]?.[0]?.text).toContain("Scade domani");
  });

  it("i salvati sono per chat e mostrano il punteggio", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "save:1", 100), deps(store, tg));
    await handleUpdate(tap(3, "save:2", 100), deps(store, tg));
    await handleUpdate(tap(4, "s:salvati", 100), deps(store, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("Salvati</b> · 2 concorsi");
    const keyboard = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const apribili = keyboard.inline_keyboard.map((riga) => riga[0]?.callback_data).filter((data) => data?.startsWith("open:"));
    expect(apribili.sort()).toEqual(["open:1", "open:2"]);
  });

  it("la sezione fonti mostra fonti e ultime raccolte", async () => {
    const { tg, calls } = makeTg();
    store.seedSources([
      {
        id: "vincimi", name: "Vincimi", kind: "rss", url: "https://v.example/feed", category: "online",
        tags: ["aggregatore"], cadenceMin: 45, enabled: true, etag: null, lastModified: null,
        lastRunAt: null, lastOkAt: "2026-11-20T09:00:00.000Z", failStreak: 0,
      },
    ]);
    await store.recordRun({
      startedAt: "2026-11-20T09:30:00.000Z", trigger: "actions", sourcesOk: 12, sourcesFail: 0, itemsNew: 22, ms: 4000, note: null,
    });
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:fonti", 100), deps(store, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("1 configurate, 1 attive");
    expect(testo).toContain("Vincimi · ok 20/11 10:00");
    expect(testo).toContain("GitHub 20/11 10:30 · 12 ok / 0 errori · 22 nuovi");
  });

  it("è idempotente sullo stesso update_id", async () => {
    const { tg, calls } = makeTg();
    expect((await handleUpdate(command(1, "/start"), deps(store, tg))).handled).toBe(true);
    calls.length = 0;
    expect((await handleUpdate(command(1, "/start"), deps(store, tg))).handled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("le chat non autorizzate ricevono solo il proprio id", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(
      { update_id: 4, message: { message_id: 7, chat: { id: 999 }, text: "/start", from: { id: 999 } } },
      deps(store, tg),
    );
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("⛔ Bot privato");
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("999");
    expect(calls.filter((call) => call.method === "deleteMessage")).toHaveLength(0);
    expect(await store.getUiState(999)).toBeNull();
  });

  it("i comandi restano scorciatoie: /scadenze apre la sezione giusta", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(command(2, "/scadenze"), deps(store, tg));
    expect((await store.getUiState(CHAT))?.section).toBe("scadenze");
    expect(lastWith(calls, "deleteMessage")?.payload.message_id).toBe(2);
  });
});

describe("digest e avvisi", () => {
  it("riconosce la fascia di silenzio", () => {
    expect(isQuietHour(prefs(), new Date("2026-11-20T23:30:00Z"))).toBe(true); // 00:30 a Roma
    expect(isQuietHour(prefs(), new Date("2026-11-20T12:00:00Z"))).toBe(false); // 13:00 a Roma
    expect(isQuietHour(prefs({ quietHours: "" }), new Date("2026-11-20T23:30:00Z"))).toBe(false);
  });

  it("trova l'URL del regolamento senza duplicare la pagina", () => {
    expect(regolamentoUrl(row({ summary: "Vedi https://esempio.it/regolamento.pdf per i dettagli" }))).toBe(
      "https://esempio.it/regolamento.pdf",
    );
    expect(regolamentoUrl(row({ url: "https://esempio.it/regolamento", summary: "" }))).toBeNull();
  });

  it("non manda digests a chi li ha spenti dalle impostazioni", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs({ digestHours: [] }));
    await seed(store, [{ title: "Concorso da digest" }]);
    const { tg, calls } = makeTg();
    const result = await sendDigests({ store, tg, now: NOW });
    expect(result).toEqual({ chats: 0, messages: 0 });
    expect(calls).toHaveLength(0);
  });
});
