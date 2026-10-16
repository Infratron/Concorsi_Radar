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
import {
  cardKeyboard,
  filtriFontiKeyboard,
  filtriKeyboard,
  itemButtonLabel,
  listKeyboard,
  menuKeyboard,
  settingsKeyboard,
  sourceToggleLabel,
} from "../src/telegram/keyboard.ts";
import { activeFilterCount, defaultFilters, filterableSources, parseFilters, withFilterChange } from "../src/filters.ts";
import { applyIntent, parseCallback } from "../src/telegram/screens.ts";
import { handleUpdate } from "../src/telegram/bot.ts";
import {
  isQuietHour,
  regolamentoUrl,
  sendDigests,
  sendInstantAlerts,
  sendWatchlistReminders,
} from "../src/telegram/digest.ts";

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
  // Messaggi che Telegram accetta ancora di modificare ma che l'utente NON vede
  // più: è il caso della chat svuotata con "Elimina conversazione".
  const invisibili = new Set<number>();
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
      // Chat svuotata: la modifica riesce (e il contenuto cambia davvero lato
      // server) ma per l'utente resta invisibile.
      if (invisibili.has(id)) {
        testi.set(id, String(payload.text));
        return jsonResponse({ ok: true, result: { message_id: id } });
      }
      if (testi.get(id) === String(payload.text)) {
        return jsonResponse({ ok: false, description: "Bad Request: message is not modified" }, 400);
      }
      testi.set(id, String(payload.text));
      return jsonResponse({ ok: true, result: { message_id: id } });
    }
    return jsonResponse({ ok: true, result: true });
  };

  return { tg: new TelegramClient("test-token", fetcher), calls, invisibili };
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
    filters: defaultFilters(),
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
    const keyboard = menuKeyboard({ nuovi: 3, oggi: 12, settimana: 40, scadenze: 2, salvati: 1, news: 7, filtri: 0 });
    const bottoni = keyboard.inline_keyboard.flat();
    expect(bottoni.map((b) => b.callback_data)).toEqual([
      "s:nuovi", "s:oggi", "s:settimana", "s:scadenze", "s:salvati", "s:news", "s:cerca", "s:storico",
      "s:filtri", "s:fonti", "s:impostazioni", "refresh",
    ]);
    expect(bottoni[0]?.text).toBe("🆕 Nuovi (3)");
    expect(bottoni[4]?.text).toBe("⭐ Watchlist (1)");
    expect(bottoni[5]?.text).toBe("📰 News (7)");
  });

  it("un articolo si riconosce dal bottone: 📰 invece di ⭐", () => {
    expect(itemButtonLabel(row({ kind: "news", title: "Tutti i concorsi del mese" }), NOW)).toContain("📰");
    expect(itemButtonLabel(row({ kind: "contest", title: "Concorso Barilla" }), NOW)).toContain("⭐");
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

  it("la scheda di un articolo avverte che il link non è la pagina del concorso", () => {
    const card = formatItemCard(row({ kind: "news", sourceId: "news-brand" }), NOW);
    expect(card).toContain("📰");
    expect(card).toContain("il link non è la pagina ufficiale");
    expect(formatItemCard(row({ kind: "contest" }), NOW)).not.toContain("pagina ufficiale");
  });

  it("nella scheda il bottone della decisione già presa è inerte", () => {
    const item = row({ id: 7 });
    const keyboard = cardKeyboard(item, "saved", "https://esempio.it/regolamento");
    const prima = keyboard.inline_keyboard[0] ?? [];
    expect(prima[0]).toEqual({ text: "⭐ In watchlist", callback_data: "noop" });
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
    expect(toast).toBe("⭐ In watchlist");
    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("⭐ <b>Nella tua watchlist</b>");
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

    const titoli = (call: Call | undefined): string[] =>
      ((call?.payload.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined)
        ?.inline_keyboard.flat() ?? [])
        .filter((bottone) => bottone.callback_data?.startsWith("open:"))
        .map((bottone) => bottone.text);
    const primaPagina = titoli(lastWith(calls, "editMessageText"));
    expect(primaPagina).toHaveLength(6);

    await handleUpdate(tap(3, "page:1", 100), deps(store2, tg));
    const seconda = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(seconda).toContain("pagina 2/2");
    const secondaPagina = titoli(lastWith(calls, "editMessageText"));
    expect(secondaPagina).toHaveLength(2);
    // Le due pagine non si sovrappongono: è la prova che la pagina si legge dal
    // database con OFFSET, non ritagliando le prime righe caricate.
    for (const titolo of secondaPagina) expect(primaPagina).not.toContain(titolo);
  });

  it("sfoglia anche oltre le prime righe caricate in memoria", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(
      store2,
      Array.from({ length: 70 }, (_, index) => ({ title: `Concorso numero ${index + 1}` })),
    );
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    await handleUpdate(tap(2, "s:oggi", 100), deps(store2, tg));
    await handleUpdate(tap(3, "page:11", 100), deps(store2, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("70 concorsi");
    expect(testo).toContain("pagina 12/12");
    const righe = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][]
    }).inline_keyboard.filter((riga) => riga[0]?.callback_data?.startsWith("open:"));
    expect(righe).toHaveLength(4);
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
    const testo = lastWith(calls, "sendMessage")?.payload.text ?? "";
    expect(testo).toContain("Ricerca: viaggio");
    expect(methods(calls)).toContain("deleteMessage");
  });

  it("fuori dalla ricerca un testo libero riapre il menù in un messaggio nuovo", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;
    await handleUpdate(command(2, "ciao"), deps(store, tg));
    // Prima sparisce il testo scritto, poi la vecchia schermata, poi arriva il menù:
    // in chat resta un messaggio solo.
    expect(methods(calls)).toEqual(["deleteMessage", "deleteMessage", "sendMessage"]);
    expect(calls[0]?.payload.message_id).toBe(2);
    expect(calls[1]?.payload.message_id).toBe(100);
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Concorsi Radar");
  });

  it("due /start di fila lasciano un solo menù in chat", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;
    await handleUpdate(command(2, "/start"), deps(store, tg));

    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload.message_id)).toEqual([
      2, 100,
    ]);
    expect((await store.getUiState(CHAT))?.messageId).toBe(101);
  });

  it("/start riapre il menù anche se la chat è stata svuotata", async () => {
    const { tg, calls, invisibili } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    expect((await store.getUiState(CHAT))?.messageId).toBe(100);

    // L'utente ha eliminato la conversazione: Telegram accetta ancora la modifica
    // di quel messaggio (risponde ok) ma non lo mostra più. Se il bot si fidasse di
    // quell'ok, il comando sparirebbe e il menù non arriverebbe mai.
    invisibili.add(100);
    calls.length = 0;
    await handleUpdate(command(2, "/start"), deps(store, tg));

    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0);
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Concorsi Radar");
    expect((await store.getUiState(CHAT))?.messageId).toBe(101);
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

  it("un tocco dal digest apre la scheda senza cancellare il digest", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;

    // Il digest è un altro messaggio (500): il prefisso d: dice di conservarlo.
    await handleUpdate(
      { update_id: 2, callback_query: { id: "cb-2", data: "d:open:3", message: { message_id: 500, chat: { id: CHAT } }, from: { id: CHAT } } },
      deps(store, tg),
    );

    expect((await store.getUiState(CHAT))?.openItemId).toBe(3);
    expect(lastWith(calls, "editMessageText")?.payload.message_id).toBe(100);
    expect(calls.filter((call) => call.method === "deleteMessage")).toHaveLength(0);
  });

  it("ripetere la stessa decisione non sposta i pesi due volte", async () => {
    const { tg } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "save:1", 100), deps(store, tg));
    await handleUpdate(tap(3, "save:1", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.weights.giftcard).toBe(1);
  });

  it("i salvati sono per chat e mostrano il punteggio", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "save:1", 100), deps(store, tg));
    await handleUpdate(tap(3, "save:2", 100), deps(store, tg));
    await handleUpdate(tap(4, "s:salvati", 100), deps(store, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("Watchlist</b> · 2 concorsi in watchlist");
    const keyboard = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const apribili = keyboard.inline_keyboard.map((riga) => riga[0]?.callback_data).filter((data) => data?.startsWith("open:"));
    expect(apribili.sort()).toEqual(["open:1", "open:2"]);
  });

  it("la watchlist è ordinata per scadenza, non per quando l'hai salvata", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [
      { title: "Chiude a dicembre", deadline: "2026-12-20", score: 99 },
      { title: "Chiude dopodomani", deadline: "2026-11-22", score: 30 },
      { title: "Chiude tra un mese", deadline: "2027-01-10", score: 80 },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    // Salvati nell'ordine peggiore possibile: il primo è quello che chiude più tardi.
    for (const id of [1, 2, 3]) await handleUpdate(tap(10 + id, `save:${id}`, 100), deps(store2, tg));
    await handleUpdate(tap(20, "s:salvati", 100), deps(store2, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("3 concorsi in watchlist");
    expect(testo).toContain("chiude prima sta in cima");
    const titoli = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][]
    }).inline_keyboard.map((riga) => riga[0]?.text ?? "");
    expect(titoli[0]).toContain("Chiude dopodomani");
    expect(titoli[1]).toContain("Chiude a dicembre");
    expect(titoli[2]).toContain("Chiude tra un mese");
  });

  it("lo storico riunisce vinti, chiusi e scartati", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [
      { title: "Concorso ancora aperto", deadline: "2026-12-20" },
      { title: "Concorso chiuso ieri", deadline: "2026-11-19" },
      { title: "Concorso chiuso a settembre", deadline: "2026-09-01" },
      { title: "Concorso da vincere", deadline: "2026-11-25" },
      { title: "Concorso scartato", deadline: "2026-11-26" },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    await handleUpdate(tap(2, "won:4", 100), deps(store2, tg));
    await handleUpdate(tap(3, "ign:5", 100), deps(store2, tg));

    await handleUpdate(tap(4, "s:storico", 100), deps(store2, tg));
    const menu = lastWith(calls, "editMessageText");
    expect(menu?.payload.text).toContain("<b>1</b> vinti");
    expect(menu?.payload.text).toContain("<b>2</b> chiusi");
    expect(menu?.payload.text).toContain("<b>1</b> scartati");
    expect((menu?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard
      .flat().map((b) => b.callback_data)).toContain("s:scaduti");

    await handleUpdate(tap(5, "s:scaduti", 100), deps(store2, tg));
    const chiusi = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(chiusi).toContain("Concorsi chiusi");
    expect(chiusi).toContain("2 concorsi chiusi");
    const titoliChiusi = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][]
    }).inline_keyboard.map((riga) => riga[0]?.text ?? "");
    // Chi ha chiuso per ultimo in cima, e il concorso ancora aperto non c'è.
    expect(titoliChiusi[0]).toContain("Concorso chiuso ieri");
    expect(titoliChiusi.join(" ")).not.toContain("ancora aperto");

    await handleUpdate(tap(6, "s:vinti", 100), deps(store2, tg));
    expect(lastWith(calls, "editMessageText")?.payload.text).toContain("1 concorso vinto");
  });

  it("la sezione news tiene separate le notizie dai concorsi", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [
      { title: "Concorso su cui si partecipa", kind: "contest" },
      { title: "Articolo che parla del concorso", kind: "news", sourceId: "news-brand" },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    // /start manda un messaggio nuovo: per rivedere il menù si tocca Aggiorna.
    await handleUpdate(tap(2, "refresh", 100), deps(store2, tg));

    // Il menù conta le due cose separatamente.
    const menu = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(menu.inline_keyboard.flat().find((b) => b.callback_data === "s:news")?.text).toBe("📰 News (1)");
    expect(menu.inline_keyboard.flat().find((b) => b.callback_data === "s:oggi")?.text).toBe("📋 Oggi (1)");

    // La sezione dei concorsi non contiene il link all'articolo...
    await handleUpdate(tap(3, "s:oggi", 100), deps(store2, tg));
    const concorsi = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(concorsi).toContain("1 concorso");
    const righeConcorsi = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    }).inline_keyboard;
    expect(righeConcorsi[0]?.[0]?.text).toContain("Concorso su cui si partecipa");
    expect(righeConcorsi.flat().some((b) => b.text.includes("Articolo che parla"))).toBe(false);

    // ...e la sezione news contiene solo quello.
    await handleUpdate(tap(4, "s:news", 100), deps(store2, tg));
    const news = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(news).toContain("Articoli e news");
    expect(news).toContain("1 articolo");
    const righeNews = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    }).inline_keyboard;
    expect(righeNews[0]?.[0]?.text).toContain("Articolo che parla del concorso");
    expect(righeNews[0]?.[0]?.text).toContain("📰");
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
    calls.length = 0;
    await handleUpdate(command(2, "/scadenze"), deps(store, tg));
    expect((await store.getUiState(CHAT))?.section).toBe("scadenze");
    // Il comando sparisce, la schermata precedente viene tolta, la nuova arriva:
    // la scorciatoia non lascia messaggi appesi.
    expect(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload.message_id)).toEqual([
      2, 100,
    ]);
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("In scadenza");
  });
});

describe("filtri personali · due chat, due feed", () => {
  const AMICA = 777;

  /** Comandi e tocchi per una chat qualsiasi: i filtri sono per chat. */
  const cmd = (chatId: number, updateId: number, text: string): TelegramUpdate => ({
    update_id: updateId,
    message: { message_id: updateId, chat: { id: chatId }, text, from: { id: chatId } },
  });
  const tapIn = (chatId: number, updateId: number, data: string, messageId: number): TelegramUpdate => ({
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data, message: { message_id: messageId, chat: { id: chatId } }, from: { id: chatId } },
  });
  const entrambe = (store: MemoryStore, tg: TelegramClient) => ({
    store,
    tg,
    now: NOW,
    adminChatId: CHAT,
    allowedChatIds: [CHAT, AMICA],
  });

  /** Testo dell'ultimo messaggio spedito/modificato, per chat, senza i tag HTML. */
  const schermata = (calls: Call[], chatId: number): string => {
    const call = [...calls]
      .reverse()
      .find((entry) => (entry.method === "editMessageText" || entry.method === "sendMessage") && entry.payload.chat_id === chatId);
    return String(call?.payload.text ?? "").replace(/<\/?b>/g, "");
  };
  const bottoni = (calls: Call[], chatId: number): { text: string; callback_data?: string }[][] => {
    const call = [...calls]
      .reverse()
      .find((entry) => (entry.method === "editMessageText" || entry.method === "sendMessage") && entry.payload.chat_id === chatId);
    const tastiera = call?.payload.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined;
    return tastiera?.inline_keyboard ?? [];
  };

  async function dueChat(store: MemoryStore): Promise<void> {
    await store.upsertPrefs(prefs());
    await store.upsertPrefs({ ...prefs(), chatId: AMICA });
  }

  it("🎛 Cosa vedi spegne un tipo di concorso solo per chi lo tocca", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Raccolta bollini Bennet", tags: ["raccolta_punti"] },
      { title: "Concorso gift card", tags: ["giftcard"] },
      { title: "Concorso viaggio a Parigi", tags: ["viaggio"] },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:filtri", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("Cosa vedi");
    expect(schermata(calls, CHAT)).toContain("solo per te");

    await handleUpdate(tapIn(CHAT, 3, "cfg:tag:raccolta_punti", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedTags).toEqual(["raccolta_punti"]);
    // Il messaggio in sovraimpressione dice cosa è successo, e la schermata resta
    // quella dei filtri (non si torna al menù a ogni tocco).
    const conferma = calls.filter((call) => call.method === "answerCallbackQuery").pop();
    expect(String(conferma?.payload.text)).toContain("Raccolte punti");
    expect(schermata(calls, CHAT)).toContain("Cosa vedi");

    // L'elenco si accorcia e il numero in testa dice che è per via dei filtri.
    await handleUpdate(tapIn(CHAT, 4, "s:oggi", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("2 concorsi");
    const titoli = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(titoli.join("\n")).not.toContain("Raccolta bollini");
    expect(titoli.join("\n")).toContain("gift card");

    await handleUpdate(tapIn(CHAT, 5, "home", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("🎛 Filtri tuoi");
    expect(schermata(calls, CHAT)).toContain("2 di 3 concorsi");

    // L'altra persona non ha toccato niente: per lei l'archivio è quello intero.
    expect((await store.getPrefs(AMICA))?.filters).toEqual(defaultFilters());
    await handleUpdate(cmd(AMICA, 6, "/start"), entrambe(store, tg));
    const suo = schermata(calls, AMICA);
    expect(suo).toContain("3 concorsi");
    expect(suo).not.toContain("Filtri tuoi");
    await handleUpdate(tapIn(AMICA, 7, "s:oggi", 200), entrambe(store, tg));
    const suoi = bottoni(calls, AMICA).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(suoi.join("\n")).toContain("Raccolta bollini");
  });

  it("spegne una fonte e una categoria, e i loro concorsi escono dall'elenco", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Concorso Vincimi", sourceId: "vincimi", tags: ["giftcard"] },
      { title: "Concorso con scontrino", sourceId: "scontrinofelice-acquisto", tags: ["acquisto"] },
      { title: "Concorso Ferrero", sourceId: "sitemap-ferrero", tags: ["brand"] },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));

    await handleUpdate(tapIn(CHAT, 2, "cfg:src:vincimi", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedSources).toEqual(["vincimi"]);

    await handleUpdate(tapIn(CHAT, 3, "cfg:cat:scontrino", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedCategories).toEqual(["scontrino"]);

    await handleUpdate(tapIn(CHAT, 4, "home", 100), entrambe(store, tg));
    const menu = schermata(calls, CHAT);
    expect(menu).toContain("1 di 3 concorsi");
    await handleUpdate(tapIn(CHAT, 5, "s:oggi", 100), entrambe(store, tg));
    const rimasti = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(rimasti.join("\n")).toContain("Ferrero");
    expect(rimasti.join("\n")).not.toContain("Vincimi");
    expect(rimasti.join("\n")).not.toContain("scontrino");
  });

  it("🎁 solo senza acquisto lascia fuori chi chiede la spesa", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Concorso gratuito Kanzi", requiresPurchase: false },
      { title: "Concorso con scontrino Conad", requiresPurchase: true },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:filtri", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 3, "cfg:free:on", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.freeOnly).toBe(true);

    await handleUpdate(tapIn(CHAT, 4, "s:oggi", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("1 concorso");
    const titoli = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(titoli.join("\n")).toContain("Kanzi");
    expect(titoli.join("\n")).not.toContain("Conad");
  });

  it("📡 Scegli le fonti si sfoglia a pagine e non torna indietro a ogni tocco", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:filtri-fonti", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("pagina 1/");

    const primaPagina = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("cfg:src:"));
    expect(primaPagina.length).toBeGreaterThan(0);
    // Ogni bottone ha un id di fonte vero: sono quelli delle fonti accese.
    const spegnibili = new Set(filterableSources().map((source) => `cfg:src:${source.id}`));
    for (const bottone of primaPagina) expect(spegnibili.has(bottone.callback_data ?? "")).toBe(true);

    await handleUpdate(tapIn(CHAT, 3, "page:1", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("pagina 2/");
    const secondaPagina = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("cfg:src:"));
    expect(secondaPagina.length).toBeGreaterThan(0);
    // Le due pagine non si sovrappongono.
    const primi = primaPagina.map((b) => b.callback_data);
    for (const bottone of secondaPagina) expect(primi).not.toContain(bottone.callback_data);

    const scelta = secondaPagina[0];
    await handleUpdate(tapIn(CHAT, 4, String(scelta.callback_data), 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedSources).toHaveLength(1);
    // Il tocco non riporta alla prima pagina: si resta dove si era.
    expect(schermata(calls, CHAT)).toContain("pagina 2/");
    const cambiato = bottoni(calls, CHAT).flat().find((b) => b.callback_data === scelta.callback_data);
    expect(cambiato?.text.startsWith("🚫")).toBe(true);
  });

  it("la riga delle stelle sta in elenco e filtra dove serve", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Concorso scarso", score: 40 },
      { title: "Concorso buono", score: 72 },
      { title: "Concorso ottimo", score: 88 },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:oggi", 100), entrambe(store, tg));

    const aperti = (): string[] =>
      bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    // La riga è una sola, in fondo all'elenco, e dice quale soglia è attiva.
    const riga = bottoni(calls, CHAT).find((riga) => riga.some((b) => b.callback_data?.startsWith("cfg:star:")));
    expect(riga?.map((b) => b.callback_data)).toEqual(["cfg:star:0", "cfg:star:70", "cfg:star:80"]);
    expect(riga?.[0]?.text.startsWith("•")).toBe(true);
    // E l'elenco è ordinato dal punteggio più alto: il primo è il migliore.
    expect(aperti()[0]).toContain("ottimo");

    await handleUpdate(tapIn(CHAT, 3, "cfg:star:80", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.minScore).toBe(80);
    expect(schermata(calls, CHAT)).toContain("Ultime 24 ore"); // resta dove sei
    expect(schermata(calls, CHAT)).toContain("1 concorso");
    expect(aperti()).toHaveLength(1);
    expect(aperti()[0]).toContain("ottimo");
    expect((await store.getPrefs(AMICA))?.filters.minScore).toBe(0);

    // Nella sezione news la riga non c'è: il punteggio di un articolo non è una stella.
    await seed(store, [{ title: "Articolo che parla di concorsi", kind: "news", score: 50 }]);
    await handleUpdate(tapIn(CHAT, 4, "s:news", 100), entrambe(store, tg));
    expect(bottoni(calls, CHAT).flat().some((b) => b.callback_data?.startsWith("cfg:star:"))).toBe(false);

    // E dalla schermata dei filtri si può rimettere su "tutte".
    await handleUpdate(tapIn(CHAT, 5, "cfg:star:0", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.minScore).toBe(0);
  });

  it("l'elenco dei concorsi parte dal punteggio più alto, non dall'ultimo arrivato", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Arrivato per ultimo e scarso", score: 30, firstSeenAt: "2026-11-20T11:00:00.000Z" },
      { title: "Arrivato prima e ottimo", score: 90, firstSeenAt: "2026-11-20T08:00:00.000Z" },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:oggi", 100), entrambe(store, tg));

    const aperti = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(aperti[0]).toContain("ottimo");
    expect(aperti[1]).toContain("scarso");
  });

  it("un elenco vuoto con i filtri attivi dice che può essere per quello", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [{ title: "Concorso scarso", score: 40 }]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:oggi", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 3, "cfg:star:80", 100), entrambe(store, tg));

    expect(schermata(calls, CHAT)).toContain("filtri attivi");
    expect(bottoni(calls, CHAT).flat().some((b) => b.callback_data === "s:filtri")).toBe(true);

    // Senza filtri, un elenco vuoto è solo un elenco vuoto: nessun invito a
    // toccare filtri che non esistono.
    const vuoto = createMemoryStore();
    await dueChat(vuoto);
    await handleUpdate(cmd(CHAT, 4, "/start"), entrambe(vuoto, tg));
    await handleUpdate(tapIn(CHAT, 5, "s:oggi", 100), entrambe(vuoto, tg));
    expect(schermata(calls, CHAT)).not.toContain("filtri attivi");
    expect(bottoni(calls, CHAT).flat().some((b) => b.callback_data === "s:filtri")).toBe(false);
  });

  it("♻️ rimette tutto come prima", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Raccolta bollini Bennet", tags: ["raccolta_punti"] },
      { title: "Concorso viaggio a Parigi", tags: ["viaggio"] },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:filtri", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 3, "cfg:tag:raccolta_punti", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 4, "cfg:free:on", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 5, "cfg:src:vincimi", 100), entrambe(store, tg));
    expect(activeFilterCount((await store.getPrefs(CHAT))!.filters)).toBe(3);

    await handleUpdate(tapIn(CHAT, 6, "cfg:reset:all", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters).toEqual(defaultFilters());
    expect(schermata(calls, CHAT)).toContain("tutto");

    await handleUpdate(tapIn(CHAT, 7, "home", 100), entrambe(store, tg));
    const menu = schermata(calls, CHAT);
    expect(menu).toContain("2 concorsi");
    expect(menu).not.toContain("Filtri tuoi");
  });

  it("un tocco con un valore inventato non entra nelle preferenze", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    const { tg } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "cfg:src:fonte-che-non-esiste", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 3, "cfg:tag:tag-inventato", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 4, "cfg:cat:marzapane", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters).toEqual(defaultFilters());
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

  it("ricorda i concorsi in watchlist prima che chiudano, senza ripetersi", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [
      { title: "Chiude tra tre giorni", deadline: "2026-11-23" },
      { title: "Chiude fra dieci giorni", deadline: "2026-11-30" },
    ]);
    for (const id of ids) await store.recordDelivery(CHAT, id, "saved", NOW.toISOString());
    const { tg, calls } = makeTg();

    // A tre giorni dalla chiusura arriva il primo promemoria; quello che chiude fra
    // dieci giorni resta in silenzio.
    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 1 });
    const primo = lastWith(calls, "sendMessage")?.payload.text ?? "";
    expect(primo).toContain("⭐ <b>Watchlist</b> · chiude tra 3 giorni");
    expect(primo).toContain("Chiude tra tre giorni");
    expect(primo).not.toContain("Chiude fra dieci giorni");

    // Lo stesso giro non lo ripete...
    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 0 });

    // ...ma il giorno prima della chiusura arriva il secondo avviso, una volta sola.
    const domani = new Date("2026-11-22T10:00:00.000Z");
    expect(await sendWatchlistReminders({ store, tg, now: domani })).toEqual({ sent: 1 });
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("chiude domani");
    expect(await sendWatchlistReminders({ store, tg, now: domani })).toEqual({ sent: 0 });
  });

  it("senza scadenza la watchlist non produce promemoria", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [{ title: "Concorso senza data", deadline: null }]);
    await store.recordDelivery(CHAT, ids[0], "saved", NOW.toISOString());
    const { tg, calls } = makeTg();

    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 0 });
    expect(calls).toHaveLength(0);
  });

  it("un articolo non fa scattare un avviso immediato, anche se ha il punteggio più alto", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs({ minScoreInstant: 60 }));
    await seed(store, [{ title: "Articolo sui concorsi", kind: "news", score: 99, sourceId: "news-brand" }]);
    const { tg, calls } = makeTg();

    expect(await sendInstantAlerts({ store, tg, now: NOW })).toEqual({ sent: 0 });
    expect(calls).toHaveLength(0);
  });

  it("gli articoli non finiscono nel digest: si leggono nella sezione news", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [{ title: "Concorso vero", kind: "contest", score: 95 }]);
    await seed(store, [{ title: "Articolo sui concorsi", kind: "news", score: 99, sourceId: "news-brand" }]);
    const { tg, calls } = makeTg();

    await sendDigests({ store, tg, now: NOW });
    const testo = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String(call.payload.text))
      .join("\n");
    expect(testo).toContain("Concorso vero");
    expect(testo).not.toContain("Articolo sui concorsi");
  });

  it("il digest porta i bottoni per aprire i concorsi, senza essere cancellato", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [{ title: "Concorso da digest" }]);
    const { tg, calls } = makeTg();

    const result = await sendDigests({ store, tg, now: NOW });
    expect(result.messages).toBe(1);

    const inviato = lastWith(calls, "sendMessage");
    const keyboard = inviato?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] };
    expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([`d:open:${ids[0]}`, "d:home"]);
  });
});
